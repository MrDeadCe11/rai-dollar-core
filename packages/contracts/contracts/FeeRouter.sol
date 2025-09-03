// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./v0.8.24/Dependencies/IERC20.sol";
import "./v0.8.24/Interfaces/IFeeRouter.sol";
import "./v0.8.24/Interfaces/IGlobalFeeRouter.sol";
import "./v0.8.24/Interfaces/ITroveManager.sol";
import "./v0.8.24/Interfaces/IStabilityPool.sol";
import "./v0.8.24/Interfaces/ILUSDToken.sol";
import "./v0.8.24/Dependencies/Ownable.sol";
import "./v0.8.24/Dependencies/CheckContract.sol";
import "./Control.sol";
import "./EmaLib.sol";

contract FeeRouter is Ownable, CheckContract, IFeeRouter{
    using EmaLib for EmaLib.State;
    using Control for Control.State;

    ITroveManager public troveManager;
    IStabilityPool public stabilityPool;
    ILUSDToken public lusdToken;
    IGlobalFeeRouter public globalFeeRouter;

    uint public constant targetSpUtil = 25 * 10**16; // 25%
    int public constant errorDeadband = 5 * 10**16; // 5%

    int public constant SP_BIAS_FRAC = 50 * 10**16; // 50%

    // SP allocation bounds
    uint public constant MIN_ALLOCATION_FRAC = 10 * 10**16; // 10%
    int public constant MIN_ALLOCATION_FRAC_I = int(MIN_ALLOCATION_FRAC);
    uint public constant MAX_ALLOCATION_FRAC = 75 * 10**16; // 75%
    int public constant MAX_ALLOCATION_FRAC_I = int(MAX_ALLOCATION_FRAC);

    uint public constant HALFLIFE = 72 hours;

    // TODO: tune kp and deadband for an appropriate SP APR jump
    // when deadband is crossed
    int public constant kp = 5 * 10**17;
    int public constant timeConstant = int(3 * HALFLIFE);
    int public constant ki = kp/timeConstant;

    // pi output
    uint public spAllocFrac = uint(SP_BIAS_FRAC);// = 50 * 10 ** 16; // 50%

    EmaLib.State private spUtilEma;
    Control.State private pi;

    event Drip(uint _spInterest, uint _remaining, uint _ema, int _integral, uint _spAllocFrac);

    function setAddresses(
        address _troveManagerAddress,
        address _stabilityPoolAddress,
        address _lusdTokenAddress,
        address _globalFeeRouterAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_troveManagerAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_lusdTokenAddress);
        checkContract(_globalFeeRouterAddress);

        troveManager = ITroveManager(_troveManagerAddress);
        stabilityPool = IStabilityPool(_stabilityPoolAddress);
        lusdToken = ILUSDToken(_lusdTokenAddress);
        globalFeeRouter = IGlobalFeeRouter(_globalFeeRouterAddress);

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit RDTokenAddressChanged(_lusdTokenAddress);
        emit GlobalFeeRouterAddressChanged(_globalFeeRouterAddress);

        // initialize EMA and PI Controller
        // Seed EMA with target
        spUtilEma.init(targetSpUtil, HALFLIFE);
        pi.init(kp, ki, SP_BIAS_FRAC, MIN_ALLOCATION_FRAC_I, MAX_ALLOCATION_FRAC_I);

        _renounceOwnership();
    }

    function previewNextAlloc(uint _currentUtil) external view returns (uint, int) {
        (uint nextEma, ) = spUtilEma.preview(_currentUtil, block.timestamp);
        int error = int(targetSpUtil) - int(nextEma);
        error = Control.deadbandError(error, errorDeadband);

        (uint out, int previewInt, ) = pi.preview(error, block.timestamp);
        return (out, previewInt);
    }

    function allocateFees(uint _totalFees) external {
        // distributes fees, then updates allocation
        _requireCallerIsTroveManager();
        // calculate fees using existing SP allocation fraction
        uint toSP = _totalFees * spAllocFrac / 10**18;

        // distribute to SP
        stabilityPool.distributeFees(toSP);

        uint remaining = _totalFees - toSP;
        globalFeeRouter.allocateFees(_totalFees, remaining);

        emit Drip(toSP, remaining, spUtilEma.ema, pi.integral, spAllocFrac);

        // now, update allocation
        _updateAllocation();

    }

    function _updateAllocation() internal {
        // measure & update EMA
        (uint newEma, ) = spUtilEma.update(_getCurrentValue());
        int error = Control.deadbandError(int(targetSpUtil) - int(newEma), errorDeadband);

        spAllocFrac = pi.update(error);
    }

    function _getCurrentValue() internal view returns (uint) {
        // calculate what % of this branch's debt is in the SP
        uint debt = troveManager.getEntireSystemDebt();
        if (debt == 0) return spUtilEma.ema;
        return stabilityPool.getTotalLUSDDeposits() * 10**18 / debt;
    }

    function spUtilizationEma() external view returns (uint256) {
        return spUtilEma.ema;
    }

    function controlIntegral() external view returns (int256) {
        return pi.integral;
    }

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == address(troveManager), "FeeRouter: Caller is not TM");
    }
}
