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
        _removeTroveOwner(_troveOwner, getTroveStorage().shielded[_troveOwner]);
    }

    function _removeTroveOwner(address _borrower, bool _shielded) internal {
        //Status troveStatus = Troves[_borrower].status;
        TroveManagerLib.removeTroveOwner(_borrower, _shielded);
        // It’s set in caller function `_closeTrove`
        // skipping this since all calling functions handle this responsibility
        //assert(troveStatus != Status.nonExistent && troveStatus != Status.active);
        // TroveStorage storage ts = getTroveStorage();
        // Trove storage t = ts.Troves[_borrower];
        // uint128 index = t.arrayIndex;

        // uint length = _shielded ? ts.ShieldedTroveOwners.length : ts.TroveOwners.length;

        // uint idxLast = length.sub(1);

        // assert(index <= idxLast);

        // address addressToMove = _shielded ? ts.ShieldedTroveOwners[idxLast] : ts.TroveOwners[idxLast];
        // ts.Troves[addressToMove].arrayIndex = index;

        // if (_shielded) {
        //     ts.ShieldedTroveOwners[index] = addressToMove;
        //     ts.ShieldedTroveOwners.pop();
        // } else {
        //     ts.TroveOwners[index] = addressToMove;
        //     ts.TroveOwners.pop();
        // }

        // emit TroveIndexUpdated(addressToMove, index, _shielded);

    }
    
}
