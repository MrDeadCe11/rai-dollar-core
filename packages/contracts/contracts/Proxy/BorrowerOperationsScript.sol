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

    function openTrove(uint _LUSDAmount, address _upperHint, address _lowerHint, uint256 _collateralToAdd) external payable {
        borrowerOperations.openTrove(_LUSDAmount, _upperHint, _lowerHint, _collateralToAdd);
    }

    function addColl(address _upperHint, address _lowerHint, uint256 _collateralToAdd) external {
        borrowerOperations.addColl(_upperHint, _lowerHint, _collateralToAdd);
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

    function adjustTrove(uint _collWithdrawal, uint _debtChange, bool isDebtIncrease, address _upperHint, address _lowerHint, uint256 _collateralToAdd) external {
        borrowerOperations.adjustTrove(_collWithdrawal, _debtChange, isDebtIncrease, _upperHint, _lowerHint, _collateralToAdd);
    }

    function claimCollateral() external {
        borrowerOperations.claimCollateral();
    }
}
