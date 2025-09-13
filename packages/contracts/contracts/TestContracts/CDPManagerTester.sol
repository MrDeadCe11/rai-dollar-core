// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../TroveManager.sol";

/* Tester contract inherits from TroveManager, and provides external functions 
for testing the parent's internal functions. */

contract TroveManagerTester is TroveManager {

    function computeICR(uint _coll, uint _debt, uint _price) external view returns (uint) {
        uint par = relayer.par();
        // TODO: use shielded bool instead of false
        return LiquityMath._computeCR(_coll, _actualDebt(_debt, false), _price, par);
    }

    function getCollGasCompensation(uint _coll) external pure returns (uint) {
        return _getCollGasCompensation(_coll);
    }

    function getLUSDGasCompensation() external pure returns (uint) {
        return LUSD_GAS_COMPENSATION;
    }

    function getCompositeDebt(uint _debt) external pure returns (uint) {
        return _getCompositeDebt(_debt);
    }

    function getActualDebtFromComposite(uint _debtVal) external pure returns (uint) {
        return _getNetDebt(_debtVal);
    }

    function callInternalRemoveTroveOwner(address _troveOwner) external {
        _removeTroveOwner(_troveOwner, shielded[_troveOwner]);
    }

        /*
    * Remove a Trove owner from the TroveOwners array, not preserving array order. Removing owner 'B' does the following:
    * [A B C D E] => [A E C D], and updates E's Trove struct to point to its new array index.
    */
    function _removeTroveOwner(address _borrower, bool _shielded) internal {
        //Status troveStatus = Troves[_borrower].status;

        // It’s set in caller function `_closeTrove`
        // skipping this since all calling functions handle this responsibility
        //assert(troveStatus != Status.nonExistent && troveStatus != Status.active);

        uint128 index = Troves[_borrower].arrayIndex;

        uint length = _shielded ? ShieldedTroveOwners.length : TroveOwners.length;

        uint idxLast = length.sub(1);

        assert(index <= idxLast);

        address addressToMove = _shielded ? ShieldedTroveOwners[idxLast] : TroveOwners[idxLast];
        Troves[addressToMove].arrayIndex = index;

        if (_shielded) {
            ShieldedTroveOwners[index] = addressToMove;
            ShieldedTroveOwners.pop();
        } else {
            TroveOwners[index] = addressToMove;
            TroveOwners.pop();
        }

        emit TroveIndexUpdated(addressToMove, index, _shielded);

    }
}
