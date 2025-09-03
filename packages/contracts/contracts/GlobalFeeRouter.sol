// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./v0.8.24/Interfaces/IAggregator.sol";
import "./v0.8.24/Interfaces/ITroveManager.sol";
import "./v0.8.24/Interfaces/IFeeRouter.sol";
import "./v0.8.24/Interfaces/IGlobalFeeRouter.sol";
import "./v0.8.24/Interfaces/IMarketOracle.sol";
import "./v0.8.24/Interfaces/ILUSDToken.sol";
import "./v0.8.24/Interfaces/ILPStaking.sol";
import "./v0.8.24/Interfaces/ILQTYStaking.sol";
import "./v0.8.24/Dependencies/IERC20.sol";
import "./v0.8.24/Dependencies/Ownable.sol";
import "./v0.8.24/Dependencies/CheckContract.sol";
import "./Control.sol";
import "./EmaLib.sol";

contract GlobalFeeRouter is Ownable, CheckContract, IGlobalFeeRouter{
    using EmaLib for EmaLib.State;
    using Control for Control.State;

    IAggregator public aggregator;
    ILPStaking public lpStaking;
    ILQTYStaking public lqtyStaking;
    IMarketOracle public marketOracle;
    ILUSDToken public lusdToken;

    uint public constant targetLpUtil = 10 * 10**16; // 10%
    int public constant errorDeadband = 5 * 10**16; // 5%

    // Bias of control output
    // TODO: derive estimate
    int public constant LP_BIAS_FRAC = 30 * 10**16;

    // LP allocation bounds(control bounds)
    uint public constant MIN_ALLOCATION_FRAC = 10 * 10 ** 16; // 10%
    int public constant MIN_ALLOCATION_FRAC_I = int(MIN_ALLOCATION_FRAC);
    uint public constant MAX_ALLOCATION_FRAC = 75 * 10 ** 16; // 75%
    int public constant MAX_ALLOCATION_FRAC_I = int(MAX_ALLOCATION_FRAC);

    // half-life of process variable EMA(LP utilization)
    uint public constant HALFLIFE = 72 hours;

    int public constant kp = 2 * 10**17;
    int public constant timeConstant = int(3 * HALFLIFE);
    int public constant ki = kp/timeConstant;

    // control output. seed w/ bias
    uint public lpAllocFrac = uint(LP_BIAS_FRAC);

    // last time funds were minted to LPs and stakers
    uint public lastDistribution;

    // Minimum frequency fees can be minted to LPs and stakers
    // TODO : optimize this against subsidy schedule
    uint public distributionFreq = 6 hours;
    uint public pendingLpDistribution;
    uint public pendingStakerDistribution;

    uint public constant oracleTargetBalance = 1000 * 10 ** 18;
    uint public constant oracleMinBalance = 200 * 10 ** 18;

    //uint256 public ema = targetLpUtil; // Scaled EMA value (1e18)

    EmaLib.State private lpUtilEma;
    Control.State private pi;

    //  Each collateral branch has a fee router
    mapping (address => bool) public authorizedFeeRouters;

    function setAddresses(
        address _aggregatorAddress,
        address _lpStakingAddress,
        address _lqtyStakingAddress,
        address _marketOracleAddress,
        address _lusdTokenAddress
    )
        external
        override
        onlyOwner
    {

        checkContract(_aggregatorAddress);
        checkContract(_lpStakingAddress);
        checkContract(_lqtyStakingAddress);
        checkContract(_marketOracleAddress);
        checkContract(_lusdTokenAddress);

        aggregator = IAggregator(_aggregatorAddress);
        lpStaking = ILPStaking(_lpStakingAddress);
        lqtyStaking = ILQTYStaking(_lqtyStakingAddress);
        marketOracle = IMarketOracle(_marketOracleAddress);
        lusdToken = ILUSDToken(_lusdTokenAddress);

        emit AggregatorAddressChanged(_aggregatorAddress);
        emit LpStakingAddressChanged(_lpStakingAddress);
        emit LQTYStakingAddressChanged(_lqtyStakingAddress);
        emit RDTokenAddressChanged(_lusdTokenAddress);

        // fetch and authorize all fee routers 
        uint256 len = aggregator.troveManagerLength();
        for (uint256 i = 0; i < len; ++i) {
            address troveManager = aggregator.troveManagers(i);
            if (troveManager == address(0)) continue;
            checkContract(troveManager);
            address feeRouter = address(ITroveManager(troveManager).feeRouter());
            checkContract(feeRouter);
            authorizedFeeRouters[feeRouter] = true;
        }

        // initialize EMA and PI Controller
        lastDistribution = block.timestamp;

        // Seed process variable(LP utilization) with target
        lpUtilEma.init(targetLpUtil, HALFLIFE);
        pi.init(kp, ki, LP_BIAS_FRAC, MIN_ALLOCATION_FRAC_I, MAX_ALLOCATION_FRAC_I);

        require(oracleMinBalance < oracleTargetBalance, "bad oracle thresholds");

        _renounceOwnership();
    }

    function previewNextAlloc(uint _currentUtil) external view returns (uint, int) {
        (uint nextEma, ) = lpUtilEma.preview(_currentUtil, block.timestamp);
        int error = int(targetLpUtil) - int(nextEma);
        error = Control.deadbandError(error, errorDeadband);

        (uint out, int previewInt, ) = pi.preview(error, block.timestamp);
        return (out, previewInt);
    }

    function _splitOracleAndRemaining(uint _amount) internal view returns (uint, uint) {
        // assumes oracleMinBalance < oracleTargetBalance, which is checked in contructor

        // fetch oracle balance
        uint256 oracleBalance = lusdToken.balanceOf(address(marketOracle));

        // if oracle has enough, everything goes to LPs and staking
        if (oracleBalance >= oracleMinBalance) {
            return (0, _amount);
        }

        // top-up oracle, the rest goes to LPs and staking
        uint256 oracleNeeded = oracleTargetBalance - oracleBalance;

        // oracle could need more than _amount
        uint256 toOracle = oracleNeeded > _amount ? _amount : oracleNeeded;
        uint256 remaining = _amount - toOracle;

        return (toOracle, remaining);

    }

    function allocateFees(uint _totalFees, uint _remaining) external {
        // upstream constraints force _remaining > 0
        _requireCallerIsAuthFeeRouter();
        require(_remaining <= _totalFees, "remaining must be lte totalFees");

        (uint toOracle, uint toLPAndStaking) = _splitOracleAndRemaining(_remaining);

        // calculate toLP using existing allocation fraction
        // LP gets lpAllocFrac of total unless the oracle needs top-up
        uint toLP = _totalFees * lpAllocFrac / 10**18;

        if (toLP > toLPAndStaking) {
            toLP = toLPAndStaking;
        }

        // stakers get remaining(could be zero)
        uint toStaking = toLPAndStaking - toLP;

        pendingLpDistribution += toLP;
        pendingStakerDistribution += toStaking;

        // distribute to oracle
        if (toOracle > 0) lusdToken.mint(address(marketOracle), toOracle);

        emit GlobalDrip(toLP, toStaking, toOracle, lpUtilEma.ema, pi.integral, lpAllocFrac);

        // if it's time, also distibute fees to LP and stakers
        if (block.timestamp - lastDistribution >= distributionFreq) _distributePending();

        // now, update allocation fraction
        _updateAllocation(toLP == toLPAndStaking);

    }

    function _distributePending() internal {
        // TODO consider zero distribution values
        // distribute to lpStaking
        //TODO add call to lpStaking
        lusdToken.mint(address(lpStaking), pendingLpDistribution);

        // distribute to lqtyStaking
        lusdToken.mint(address(lqtyStaking), pendingStakerDistribution);
        lqtyStaking.increaseF_LUSD(pendingStakerDistribution);

        // reset values and update time
        pendingLpDistribution = 0;
        pendingStakerDistribution = 0;
        lastDistribution = block.timestamp;

    }

    function _updateAllocation(bool capActive) internal {
        // measure & update EMA
        (uint newEma, ) = lpUtilEma.update(_getCurrentValue());

        int error = Control.deadbandError(int(targetLpUtil) - int(newEma), errorDeadband);

        // If an external high-side cap is active and error would push further into the cap,
        // hold the integrator; otherwise do a normal PI update.
        if (capActive && error > 0) {
            lpAllocFrac = pi.updateHoldIntegral(error);
        } else {
            lpAllocFrac = pi.update(error);
        }
    }

    function pendingFees() external view returns (uint) {
        return pendingLpDistribution + pendingStakerDistribution;
    }

    function _getCurrentValue() internal view returns (uint) {
        uint debt = aggregator.getEntireSystemDebt();
        if (debt == 0) return lpUtilEma.ema;
        return marketOracle.rdLiquidity() * 10**18 / debt;
    }

    function lpUtilizationEma() external view returns (uint256) {
        return lpUtilEma.ema;
    }

    function controlIntegral() external view returns (int256) {
        return pi.integral;
    }

    function controlLastUpdate() external view returns (uint256) {
        return pi.lastUpdate;
    }

    function controlPrevError() external view returns (int256) {
        return pi.prevError;
    }

    function _requireCallerIsAuthFeeRouter() internal view {
        require(authorizedFeeRouters[msg.sender], "GlobalFeeRouter: Caller is not an authorized Fee Router");
    }
}
