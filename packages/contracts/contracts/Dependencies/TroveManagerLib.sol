// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.6.11;

import {ITroveManagerStorage} from "../Interfaces/ITroveManagerStorage.sol";
import {SafeMath} from "../Dependencies/SafeMath.sol";
import {LiquityMath} from "../Dependencies/LiquityMath.sol";
import "../Interfaces/IActivePool.sol";

library TroveManagerLib {

    using SafeMath for uint;

    function getContractsStorage() private pure returns (ITroveManagerStorage.ContractsStorage storage $) {
        assembly {
            //kecca256("raidollar.trovemanager.contractscache")
            $_slot := 0xd4966da17e8d83425f4f200d96021f3889de7fba79ec270c327dc6f400c90527
        }
    }

    function getTroveStorage() private pure returns (ITroveManagerStorage.TroveStorage storage $) {
        assembly {
            //kecca256("raidollar.trovemanager.trovestorage")
            $_slot := 0xb4a7d751cb0b438867fefd66a43523806e84b89b85fea4b445161a0afe9bcc82
        }
    }

    function shieldTrove(address _borrower, address _upperHint, address _lowerHint, uint accumulatedRate, uint accumulatedShieldRate, IActivePool _activePool, IActivePool _activeShieldedPool) external  {

        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();
        ITroveManagerStorage.Trove storage t = ts.Troves[_borrower];
        bool shielded = ts.shielded[_borrower];
        require(t.status == ITroveManagerStorage.Status.active, "Trove is not active");
        require(!shielded, "Trove is already shielded");

        uint256 currentNormDebt = t.debt;

        if (currentNormDebt > 0) {
            // Remove from base pool
            _activePool.decreaseLUSDDebt(currentNormDebt);

            // Convert normalized debt from base to shielded
            uint256 newNormDebt = currentNormDebt * accumulatedRate / accumulatedShieldRate;
            t.debt = newNormDebt;
            // Add to shielded pool
           _activeShieldedPool.increaseLUSDDebt(newNormDebt);
        }

        ts.shielded[_borrower] = true;

        // must remove first
        _removeTroveOwnerFromArray(_borrower, false);

        // add to shielded array
        _addShieldedTroveOwnerToArray(_borrower);

        // add to shielded list
        contractsCache.sortedShieldedTroves.insert(_borrower, getNominalICR(_borrower), _upperHint, _lowerHint);

        // remove from base list
        contractsCache.sortedTroves.remove(_borrower);
    }

    function unShieldTrove(address _borrower, address _upperHint, address _lowerHint, uint accumulatedRate, uint accumulatedShieldRate, IActivePool _activePool, IActivePool _activeShieldedPool) external  {

        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();
        ITroveManagerStorage.Trove storage t = ts.Troves[_borrower];
        bool  shielded = ts.shielded[_borrower];
        require(t.status == ITroveManagerStorage.Status.active, "Trove is not active");
        require(shielded, "Trove is already unshielded");
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        uint256 currentNormDebt = t.debt;

        if (currentNormDebt > 0) {
            // Remove from shielded pool
            _activeShieldedPool.decreaseLUSDDebt(currentNormDebt);

            // Convert normalized debt from shielded to base
            uint256 newNormDebt = currentNormDebt * accumulatedShieldRate / accumulatedRate;
            t.debt = newNormDebt;

            // Add to base pool
            _activePool.increaseLUSDDebt(newNormDebt);
        }

        ts.shielded[_borrower] = false;

        // must remove first
        _removeTroveOwnerFromArray(_borrower, true);

        // add to base array
        _addTroveOwnerToArray(_borrower, false);

        // add to base list
        contractsCache.sortedTroves.insert(_borrower, getNominalICR(_borrower), _upperHint, _lowerHint);


        // remove from shielded list
        contractsCache.sortedShieldedTroves.remove(_borrower);
    }

    function createTrove(address _borrower, uint _nicr, address _upperHint, address _lowerHint, bool _redemptionShield) external  {
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();

        require(ts.Troves[_borrower].status != ITroveManagerStorage.Status.active, "Trove is already active");
        ts.shielded[_borrower] = _redemptionShield;

        if (_redemptionShield) {
            _addTroveOwnerToArray(_borrower, true);
            contractsCache.sortedShieldedTroves.insert(_borrower, _nicr, _upperHint, _lowerHint);
        } else {
            _addTroveOwnerToArray(_borrower, false);
            contractsCache.sortedTroves.insert(_borrower, _nicr, _upperHint, _lowerHint);
        }

    }

    function getNominalICR(address _borrower) public view returns (uint) {
        ITroveManagerStorage.ContractsStorage memory _contractsCache = getContractsStorage();
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_contractsCache, _borrower);
        uint NICR = LiquityMath._computeNominalCR(currentCollateral, currentLUSDDebt);
        return NICR;
    }

    function _getCurrentTroveAmounts(ITroveManagerStorage.ContractsStorage memory _contractsCache, address _borrower) internal view returns (uint, uint) {
        // Compute and apply pending collateral rewards
        ITroveManagerStorage.Trove storage t = getTroveStorage().Troves[_borrower];
        return (t.coll.add(_contractsCache.rewards.getPendingCollateralReward(_borrower)),
                t.debt.add(_contractsCache.rewards.getPendingLUSDDebtReward(_borrower)));
    }

    function _addShieldedTroveOwnerToArray(address _borrower) internal returns (uint128 index) {
        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();
        // Push the Troveowner to the array
        ts.ShieldedTroveOwners.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(ts.ShieldedTroveOwners.length.sub(1));
        ts.Troves[_borrower].arrayIndex = index;

        return index;
    }

    function _addTroveOwnerToArray(address _borrower, bool _shielded) internal returns (uint128 index) {
        // Push the Troveowner to the array
        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();
        address[] storage array = _shielded ? ts.ShieldedTroveOwners : ts.TroveOwners;

        array.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(array.length.sub(1));
        ts.Troves[_borrower].arrayIndex = index;

        return index;
    }

    function _removeTroveOwnerFromArray(address _borrower, bool _shielded) internal {
        //Status troveStatus = Troves[_borrower].status;

        // It’s set in caller function `_closeTrove`
        // skipping this since all calling functions handle this responsibility
        //assert(troveStatus != Status.nonExistent && troveStatus != Status.active);
        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();
        uint128 index = ts.Troves[_borrower].arrayIndex;

        address[] storage array = _shielded ? ts.ShieldedTroveOwners : ts.TroveOwners;

        uint length = array.length;

        uint idxLast = length.sub(1);

        assert(index <= idxLast);

        address addressToMove = array[idxLast];
        ts.Troves[addressToMove].arrayIndex = index;

        array[index] = addressToMove;
        array.pop();

        //emit TroveIndexUpdated(addressToMove, index, _shielded);

    }
    
}