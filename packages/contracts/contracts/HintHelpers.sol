// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/IAggregator.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
// import "./Dependencies/console.sol";

contract HintHelpers is LiquityBase, Ownable, CheckContract {
    string constant public NAME = "HintHelpers";

    ISortedTroves public sortedTroves;
    ISortedTroves public sortedShieldedTroves;
    ITroveManager public troveManager;
    IRewards public rewards;
    IAggregator public aggregator;

    // --- Events ---

    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event SortedShieldedTrovesAddressChanged(address _sortedShieldedTrovesAddress);
    event TroveManagerAddressChanged(address _troveManagerAddress);
    event RewardsAddressChanged(address _rewardsAddress);
    event RelayerAddressChanged(address _relayerAddress);

    struct HintLocals {
        uint coll;
        uint newColl;
        uint newDebt;
        uint compositeDebt;
        uint nCompositeDebt;
        uint maxRedeemableLUSD;
        uint remainingLUSD;
        address curBase; 
        address curSh;
        address firstRedemptionHint;
        uint partialRedemptionHintNICR;
        uint truncatedLUSDamount;
        uint parUsed;
        uint accRateUsed;
        uint accShieldRateUsed;
        uint totalLUSDSupplyAtStart;
    }

    // --- Dependency setters ---

    function setAddresses(
        address _sortedTrovesAddress,
        address _sortedShieldedTrovesAddress,
        address _troveManagerAddress,
        address _rewardsAddress,
        address _relayerAddress,
        address _aggregatorAddress
    )
        external
        onlyOwner
    {
        checkContract(_sortedTrovesAddress);
        checkContract(_sortedShieldedTrovesAddress);
        checkContract(_troveManagerAddress);
        checkContract(_rewardsAddress);
        checkContract(_relayerAddress);
        checkContract(_aggregatorAddress);

        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        sortedShieldedTroves = ISortedTroves(_sortedShieldedTrovesAddress);
        troveManager = ITroveManager(_troveManagerAddress);
        rewards = IRewards(_rewardsAddress);
        relayer = IRelayer(_relayerAddress);
        aggregator = IAggregator(_aggregatorAddress);

        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit SortedShieldedTrovesAddressChanged(_sortedShieldedTrovesAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit RewardsAddressChanged(_rewardsAddress);
        emit RelayerAddressChanged(_relayerAddress);

        _renounceOwnership();
    }

    // --- Functions ---

    /* getRedemptionHints() - Helper function for finding the right hints to pass to redeemCollateral().
     *
     * It simulates a redemption of `_LUSDamount` to figure out where the redemption sequence will start and what state the final Trove
     * of the sequence will end up in.
     *
     * Returns three hints:
     *  - `firstRedemptionHint` is the address of the first Trove with ICR >= MCR (i.e. the first Trove that will be redeemed).
     *  - `partialRedemptionHintNICR` is the final nominal ICR of the last Trove of the sequence after being hit by partial redemption,
     *     or zero in case of no partial redemption.
     *  - `truncatedLUSDamount` is the maximum amount that can be redeemed out of the the provided `_LUSDamount`. This can be lower than
     *    `_LUSDamount` when redeeming the full amount would leave the last Trove of the redemption sequence with less net debt than the
     *    minimum allowed value (i.e. MIN_NET_DEBT).
     *
     * The number of Troves to consider for redemption can be capped by passing a non-zero value as `_maxIterations`, while passing zero
     * will leave it uncapped.
     */

    function getRedemptionHints(
        uint _LUSDamount,
        uint _price,
        uint _maxIterations
    )
        external
        view
        returns (
            address firstRedemptionHint,
            uint partialRedemptionHintNICR,
            uint truncatedLUSDamount
        )
    {
        HintLocals memory vars;
        vars.totalLUSDSupplyAtStart = troveManager.getEntireSystemDebt(troveManager.accumulatedRate(), troveManager.accumulatedShieldRate());
        vars.remainingLUSD = _LUSDamount;
        if (_maxIterations == 0) { _maxIterations = type(uint).max; }

        // seed first redeemable base trove (ICR ≥ MCR)
        vars.curBase = sortedTroves.getLast();
        while (vars.curBase != address(0) && troveManager.getCurrentICR(vars.curBase, _price) < MCR) {
            vars.curBase = sortedTroves.getPrev(vars.curBase); // prev => larger ICR
        }

        // seed first redeemable shielded trove (MCR ≤ ICR < HCR)
        vars.curSh = sortedShieldedTroves.getLast();
        while (vars.curSh != address(0)) {
            uint icrS = troveManager.getCurrentICR(vars.curSh, _price);
            if (icrS >= MCR) { if (icrS < HCR) { break; } else { vars.curSh = address(0); break; } }
            vars.curSh = sortedShieldedTroves.getPrev(vars.curSh);
        }

        // pick the first hint(lowest ICR) between base and shielded lists
        uint icrB = vars.curBase == address(0) ? type(uint).max : troveManager.getCurrentICR(vars.curBase, _price);
        uint icrS = vars.curSh   == address(0) ? type(uint).max : troveManager.getCurrentICR(vars.curSh,   _price);
        if (icrB == type(uint).max && icrS == type(uint).max) {
            // no redeemables at all
            return (address(0), 0, 0);
        }
        firstRedemptionHint = (icrB <= icrS) ? vars.curBase : vars.curSh;

        vars.parUsed = relayer.par();
        vars.accRateUsed = troveManager.accumulatedRate();
        vars.accShieldRateUsed = troveManager.accumulatedShieldRate();

        // walk through both lists in total NICR order
        while (vars.remainingLUSD > 0 && _maxIterations-- > 0 && (vars.curBase != address(0) || vars.curSh != address(0))) {
            // compute eligible ICRs for current heads
            icrB = type(uint).max;
            icrS = type(uint).max;

            // get next redeemable base ICR
            if (vars.curBase != address(0)) {
                uint b = troveManager.getCurrentICR(vars.curBase, _price);
                if (b >= MCR) icrB = b;
            }

            // get next redeemable shielded ICR
            if (vars.curSh != address(0)) {
                uint s = troveManager.getCurrentICR(vars.curSh, _price);
                if (s >= MCR && s < HCR) icrS = s;
            }

            // if no redeemable, stop
            if (icrB == type(uint).max && icrS == type(uint).max) { break; }

            // pick lowest ICR of both lists for next trove
            bool pickBase = (icrB <= icrS);
            address who = pickBase ? vars.curBase : vars.curSh;

            // add pending rewards to get total actual net debt
            uint netLUSDDebt = _getNetDebt(troveManager.getTroveActualDebt(who))
                .add(troveManager.getPendingActualLUSDDebtReward(who));

            // TODO; make the rounding here match TM
            if (netLUSDDebt > vars.remainingLUSD) {
                // this is the partial trove (if any)
                if (netLUSDDebt > MIN_NET_DEBT) {
                    vars.maxRedeemableLUSD = LiquityMath._min(vars.remainingLUSD, netLUSDDebt.sub(MIN_NET_DEBT));

                    vars.coll = troveManager.getTroveColl(who)
                        .add(rewards.getPendingCollateralReward(who));

                    // Compute gross collateral equivalent for this redemption lot
                    uint collateralGross = vars.maxRedeemableLUSD.mul(vars.parUsed).div(_price);
                    // Apply redemption fee so that the fee remains in the trove, matching TroveManager logic
                    uint projectedRedemptionRate = aggregator.calcBaseRateForRedemption(_LUSDamount, _price, vars.parUsed, vars.totalLUSDSupplyAtStart);
                    // Cap at 100%
                    projectedRedemptionRate = LiquityMath._min(projectedRedemptionRate, DECIMAL_PRECISION);
                    
                    uint collateralFee = projectedRedemptionRate.mul(collateralGross).div(DECIMAL_PRECISION);
                    uint collateralNet = collateralGross.sub(collateralFee);

                    vars.newColl = vars.coll.sub(collateralNet);
                    vars.newDebt = netLUSDDebt.sub(vars.maxRedeemableLUSD);
                    vars.compositeDebt = _getCompositeDebt(vars.newDebt);

                    // pick the right accumulator for this trove’s class
                    bool isSh = troveManager.shielded(who);
                    vars.nCompositeDebt = isSh
                        ? _normalizedDebt(vars.compositeDebt, vars.accShieldRateUsed)
                        : _normalizedDebt(vars.compositeDebt, vars.accRateUsed);

                    partialRedemptionHintNICR = LiquityMath._computeNominalCR(vars.newColl, vars.nCompositeDebt);

                    vars.remainingLUSD = vars.remainingLUSD.sub(vars.maxRedeemableLUSD);
                }
                break; // done: either we consumed all or we found partial and exit
            } else {
                // full redemption of this trove
                vars.remainingLUSD = vars.remainingLUSD.sub(netLUSDDebt);

                // advance only the chosen list
                if (pickBase) {
                    vars.curBase = sortedTroves.getPrev(who);
                } else {
                    vars.curSh   = sortedShieldedTroves.getPrev(who);
                }
            }
        }

        truncatedLUSDamount = _LUSDamount.sub(vars.remainingLUSD);
    }

    /** getApproxHint() - return address of a Trove that is, on average, (length / numTrials) positions away in the 
    sortedTroves list from the correct insert position of the Trove to be inserted. 
    
    Note: The output address is worst-case O(n) positions away from the correct insert position, however, the function 
    is probabilistic. Input can be tuned to guarantee results to a high degree of confidence, e.g:

    Submitting numTrials = k * sqrt(length), with k = 15 makes it very, very likely that the ouput address will 
    be <= sqrt(length) positions away from the correct insert position.

     * @notice Approximate hint inside either the base or shielded list.
     * @param _NICR Target nominal ICR you intend to insert at.
     * @param _numTrials Number of random samples. Rule of thumb: k*sqrt(n), k≈15.
     * @param _inputRandomSeed Arbitrary seed for deterministic chaining.
     * @param _shielded If true, sample ShieldedTroveOwners; else Base TroveOwners.
     * @return hintAddress Member of the chosen list near _NICR.
     * @return diff |NICR(hintAddress) - _NICR|.
     * @return latestRandomSeed New seed for caller to chain calls.
    */
    function getApproxHint(
        uint _NICR,
        uint _numTrials,
        uint _inputRandomSeed,
        bool _shielded
    )
        external
        view
        returns (address hintAddress, uint diff, uint latestRandomSeed)
    {
        // Select list + owners array
        ISortedTroves list = _shielded ? sortedShieldedTroves : sortedTroves;
        uint arrayLength = _shielded ? troveManager.getShieldedTroveOwnersCount() : troveManager.getTroveOwnersCount();

        if (arrayLength == 0) {
            return (address(0), 0, _inputRandomSeed);
        }

        // Seed with the tail of the corresponding list
        hintAddress = list.getLast();
        if (hintAddress == address(0)) {
            // Fallback: if list is momentarily empty but owners exist, seed from a random owner
            uint idx0 = uint(keccak256(abi.encodePacked(_inputRandomSeed))) % arrayLength;
            hintAddress = _shielded
                ? troveManager.getTroveFromShieldedTroveOwnersArray(idx0)
                : troveManager.getTroveFromTroveOwnersArray(idx0);
        }

        diff = LiquityMath._getAbsoluteDifference(
            _NICR,
            troveManager.getNominalICR(hintAddress)
        );

        latestRandomSeed = _inputRandomSeed;

        // Random sampling over the correct owners array
        for (uint i = 1; i < _numTrials; i++) {
            latestRandomSeed = uint(keccak256(abi.encodePacked(latestRandomSeed)));

            uint arrayIndex = latestRandomSeed % arrayLength;
            address currentAddress = _shielded
                ? troveManager.getTroveFromShieldedTroveOwnersArray(arrayIndex)
                : troveManager.getTroveFromTroveOwnersArray(arrayIndex);

            uint currentNICR = troveManager.getNominalICR(currentAddress);
            uint currentDiff = LiquityMath._getAbsoluteDifference(currentNICR, _NICR);

            if (currentDiff < diff) {
                diff = currentDiff;
                hintAddress = currentAddress;
            }
        }
    }

    function _getTrials(uint nB, uint nS, uint numTrials) internal pure returns (uint tB, uint tS) {
        // Allocate trials across lists (proportional to sizes, but at least 1 if non-empty).
        uint tot = nB + nS;

        tB = (tot == 0 || numTrials == 0) ? 0 : (numTrials * nB) / tot;
        tS = (tot == 0 || numTrials == 0) ? 0 : (numTrials - tB);
        if (nB > 0 && tB == 0) tB = 1;
        if (nS > 0 && tS == 0) tS = 1;

    }

    /// @notice For a target NICR (from getRedemptionHints), return exact insert positions for BOTH lists.
    /// @dev Frontend passes all four to redeemCollateral; contract picks based on trove’s list.
    function getInsertHintsForRedemption(
        uint targetNICR,
        uint numTrials,
        uint seed
    )
        external
        view
        returns (
            address upperBase, address lowerBase,
            address upperShield, address lowerShield,
            uint seedOut
        )
    {
        (uint tB, uint tS) = _getTrials(sortedTroves.getSize(), sortedShieldedTroves.getSize(), numTrials);

        address approxB;
        address approxS;
        (approxB,,seedOut) = _approxOnList(sortedTroves, targetNICR, tB, seed);
        (approxS,,seedOut) = _approxOnList(sortedShieldedTroves, targetNICR, tS, seed);

        // Compute exact neighbors on each list using its own hint
        (upperBase, lowerBase) = _find(sortedTroves, targetNICR, approxB);
        (upperShield, lowerShield) = _find(sortedShieldedTroves, targetNICR, approxS);

        //seedOut = seed;
    }

    function _find(ISortedTroves list, uint nicr, address hint)
        internal view returns (address upper, address lower)
    {
        // Safe even if hint==address(0) or stale; SortedTroves will walk as needed.
        return list.findInsertPosition(nicr, hint, hint);
    }    

    function _approxOnList(
        ISortedTroves list,
        uint targetNICR,
        uint trials,
        uint seed
    )
        internal
        view
        returns (address best, uint bestDiff, uint seedOut)
    {
        uint n = list.getSize();
        if (n == 0 || trials == 0) { return (address(0), 0, seed); }

        best = list.getLast();
        bestDiff = LiquityMath._getAbsoluteDifference(troveManager.getNominalICR(best), targetNICR);
        seedOut = seed;

        for (uint i = 1; i < trials; i++) {
            seedOut = uint(keccak256(abi.encodePacked(seedOut)));
            uint steps = seedOut % n;
            address node = list.getLast();
            while (steps > 0 && node != address(0)) { node = list.getPrev(node); steps--; }
            if (node == address(0)) continue;

            uint d = LiquityMath._getAbsoluteDifference(troveManager.getNominalICR(node), targetNICR);
            if (d < bestDiff) {
                best = node;
                bestDiff = d;
            }
        }
    }

    function computeNominalCR(uint _coll, uint _debt) external pure returns (uint) {
        return LiquityMath._computeNominalCR(_coll, _debt);
    }

    function computeCR(uint _coll, uint _debt, uint _price) external view returns (uint) {
        uint par = relayer.par();
        return LiquityMath._computeCR(_coll, _debt, _price, par);
    }
}
