// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/CheckContract.sol";
import "../Interfaces/IBorrowerOperations.sol";


contract BorrowerOperationsScript is CheckContract {
    IBorrowerOperations immutable borrowerOperations;

    constructor(IBorrowerOperations _borrowerOperations) public {
        checkContract(address(_borrowerOperations));
        borrowerOperations = _borrowerOperations;
    }

    function openTrove(uint256 _collateralToAdd, uint _LUSDAmount, address _upperHint, address _lowerHint, bool _redemptionShield) external payable {
        borrowerOperations.openTrove(_collateralToAdd, _LUSDAmount, _upperHint, _lowerHint, _redemptionShield);
    }

    function addColl(uint256 _collateralToAdd, address _upperHint, address _lowerHint) external {
        borrowerOperations.addColl(_collateralToAdd, _upperHint, _lowerHint);
    }

    function withdrawColl(uint _amount, address _upperHint, address _lowerHint) external {
        borrowerOperations.withdrawColl(_amount, _upperHint, _lowerHint);
    }

    function withdrawLUSD(uint _amount, address _upperHint, address _lowerHint) external {
        borrowerOperations.withdrawLUSD(_amount, _upperHint, _lowerHint);
    }

    function repayLUSD(uint _amount, address _upperHint, address _lowerHint) external {
        borrowerOperations.repayLUSD(_amount, _upperHint, _lowerHint);
    }

    function closeTrove() external {
        borrowerOperations.closeTrove();
    }

    function adjustTrove(uint256 _collateralToAdd, uint _collWithdrawal, uint _debtChange, bool isDebtIncrease, bool toggleShield, address _upperHint, address _lowerHint) external {
        borrowerOperations.adjustTrove(_collateralToAdd, _collWithdrawal, _debtChange, isDebtIncrease, toggleShield, _upperHint, _lowerHint);
    }

    function claimCollateral() external {
        borrowerOperations.claimCollateral();
    }
}
