// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../BorrowerOperations.sol";

/* Tester contract inherits from BorrowerOperations, and provides external functions 
for testing the parent's internal functions. */
contract BorrowerOperationsTester is BorrowerOperations {

    function getNewICRFromTroveChange
    (
        uint _coll, 
        uint _debt, 
        uint _collChange, 
        bool isCollIncrease, 
        uint _debtChange, 
        bool isDebtIncrease, 
        uint _price
    ) 
    external
    view
    returns (uint)
    {
        uint par = relayer.par();
        return _getNewICRFromTroveChange(_coll, _debt, _collChange, isCollIncrease,
                                         _debtChange, isDebtIncrease, _price, par);
    }

    function getNewTCRFromTroveChange
    (
        uint _collChange, 
        bool isCollIncrease,  
        uint _debtChange, 
        bool isDebtIncrease, 
        uint _price
    ) 
    external 
    view
    returns (uint) 
    {
        uint par = relayer.par();
        uint accRate = troveManager.accumulatedRate();
        uint accShieldRate = troveManager.accumulatedRate();
        return _getNewTCRFromTroveChange(_collChange, isCollIncrease, _debtChange,
                                         isDebtIncrease, _price, par, accRate, accShieldRate);
    }

    function getUSDValue(uint _coll, uint _price) external pure returns (uint) {
        return _getUSDValue(_coll, _price);
    }

    function callInternalAdjustLoan
    (
        address _borrower, 
        uint _collIncrease,
        uint _collWithdrawal, 
        uint _debtChange, 
        bool _isDebtIncrease, 
        address _upperHint,
        address _lowerHint)
        external 
    {
        _adjustTrove(_borrower, _collIncrease, _collWithdrawal, _debtChange, _isDebtIncrease, false, _upperHint, _lowerHint);
    }


    // Payable fallback function
    receive() external payable { }
}
