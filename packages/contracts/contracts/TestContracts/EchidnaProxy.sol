// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../TroveManager.sol";
import "../Liquidations.sol";
import "../BorrowerOperations.sol";
import "../StabilityPool.sol";
import "../LUSDToken.sol";

contract EchidnaProxy {
    TroveManager troveManager;
    Liquidations liquidations;
    BorrowerOperations borrowerOperations;
    StabilityPool stabilityPool;
    LUSDToken lusdToken;

    constructor(
        TroveManager _troveManager,
        BorrowerOperations _borrowerOperations,
        StabilityPool _stabilityPool,
        LUSDToken _lusdToken
    ) public {
        troveManager = _troveManager;
        borrowerOperations = _borrowerOperations;
        stabilityPool = _stabilityPool;
        lusdToken = _lusdToken;
    }

    receive() external payable {
        // do nothing
    }

    // TroveManager

    function liquidatePrx(address _user) external {
        liquidations.liquidate(_user);
    }

    function liquidateTrovesPrx(uint _n) external {
        liquidations.liquidateTroves(_n);
    }

    function batchLiquidateTrovesPrx(address[] calldata _troveArray) external {
        liquidations.batchLiquidate(_troveArray);
    }

    function redeemCollateralPrx(
        uint _LUSDAmount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint _partialRedemptionHintNICR,
        uint _maxIterations,
        uint _maxFee
    ) external {
        troveManager.redeemCollateral(_LUSDAmount, _firstRedemptionHint, _upperPartialRedemptionHint, _lowerPartialRedemptionHint, _partialRedemptionHintNICR, _maxIterations, _maxFee);
    }

    // Borrower Operations
    function openTrovePrx(uint _collateralToAdd, uint _LUSDAmount, address _upperHint, address _lowerHint) external payable {
        borrowerOperations.openTrove(_collateralToAdd, _LUSDAmount, _upperHint, _lowerHint);
    }

    function addCollPrx(uint _collateralToAdd, address _upperHint, address _lowerHint) external {
        borrowerOperations.addColl(_collateralToAdd, _upperHint, _lowerHint);
    }

    function withdrawCollPrx(uint _amount, address _upperHint, address _lowerHint) external {
        borrowerOperations.withdrawColl(_amount, _upperHint, _lowerHint);
    }

    function withdrawLUSDPrx(uint _amount, address _upperHint, address _lowerHint) external {
        borrowerOperations.withdrawLUSD(_amount, _upperHint, _lowerHint);
    }

    function repayLUSDPrx(uint _amount, address _upperHint, address _lowerHint) external {
        borrowerOperations.repayLUSD(_amount, _upperHint, _lowerHint);
    }

    function closeTrovePrx() external {
        borrowerOperations.closeTrove();
    }

    function adjustTrovePrx(uint256 _collateralToAdd, uint _collWithdrawal, uint _debtChange, bool _isDebtIncrease, address _upperHint, address _lowerHint) external {
        borrowerOperations.adjustTrove(_collateralToAdd, _collWithdrawal, _debtChange, _isDebtIncrease, _upperHint, _lowerHint);
    }

    // Pool Manager
    function provideToSPPrx(uint _amount, address _frontEndTag) external {
        stabilityPool.provideToSP(_amount, _frontEndTag);
    }

    function withdrawFromSPPrx(uint _amount) external {
        stabilityPool.withdrawFromSP(_amount);
    }

    // LUSD Token

    function transferPrx(address recipient, uint256 amount) external returns (bool) {
        return lusdToken.transfer(recipient, amount);
    }

    function approvePrx(address spender, uint256 amount) external returns (bool) {
        return lusdToken.approve(spender, amount);
    }

    function transferFromPrx(address sender, address recipient, uint256 amount) external returns (bool) {
        return lusdToken.transferFrom(sender, recipient, amount);
    }

    function increaseAllowancePrx(address spender, uint256 addedValue) external returns (bool) {
        return lusdToken.increaseAllowance(spender, addedValue);
    }

    function decreaseAllowancePrx(address spender, uint256 subtractedValue) external returns (bool) {
        return lusdToken.decreaseAllowance(spender, subtractedValue);
    }
}
