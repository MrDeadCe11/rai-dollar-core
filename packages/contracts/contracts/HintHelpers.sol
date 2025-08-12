// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
import "./Interfaces/ISortedTroves.sol";
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

    // --- Events ---

    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event SortedShieldedTrovesAddressChanged(address _sortedShieldedTrovesAddress);
    event TroveManagerAddressChanged(address _troveManagerAddress);
    event RewardsAddressChanged(address _rewardsAddress);
    event RelayerAddressChanged(address _relayerAddress);

    struct HintLocals {
        uint par;
        uint price;
        uint accRate;
        uint accShieldRate;
        uint remainingLUSD;
        address curBase; 
        address curSh;
    }


    // --- Dependency setters ---

    function setAddresses(
        address _sortedTrovesAddress,
        address _sortedShieldedTrovesAddress,
        address _troveManagerAddress,
        address _rewardsAddress,
        address _relayerAddress
    )
        external
        onlyOwner
    {
        checkContract(_sortedTrovesAddress);
        checkContract(_sortedShieldedTrovesAddress);
        checkContract(_troveManagerAddress);
        checkContract(_rewardsAddress);
        checkContract(_relayerAddress);

        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        sortedShieldedTroves = ISortedTroves(_sortedShieldedTrovesAddress);
        troveManager = ITroveManager(_troveManagerAddress);
        rewards = IRewards(_rewardsAddress);
        relayer = IRelayer(_relayerAddress);

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

    /*
    function getRedemptionHintsOld(
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
        ISortedTroves sortedTrovesCached = sortedTroves;

        uint par = relayer.par();
        uint remainingLUSD = _LUSDamount;
        address currentTroveuser = sortedTrovesCached.getLast();

        while (currentTroveuser != address(0) && troveManager.getCurrentICR(currentTroveuser, _price) < MCR) {
            currentTroveuser = sortedTrovesCached.getPrev(currentTroveuser);
        }

        firstRedemptionHint = currentTroveuser;

        if (_maxIterations == 0) {
            _maxIterations = uint(-1);
        }

        uint accRate = troveManager.accumulatedRate();
        uint accShieldRate = troveManager.accumulatedShieldRate();

        while (currentTroveuser != address(0) && remainingLUSD > 0 && _maxIterations-- > 0) {
            // norm
            //uint netLUSDDebt = _getNetDebt(troveManager.getTroveDebt(currentTroveuser))
            //    .add(troveManager.getPendingLUSDDebtReward(currentTroveuser));

            // actual
            uint netLUSDDebt = _getNetDebt(troveManager.getTroveActualDebt(currentTroveuser))
                .add(troveManager.getPendingActualLUSDDebtReward(currentTroveuser));

            if (netLUSDDebt > remainingLUSD) {
                if (netLUSDDebt > MIN_NET_DEBT) {
                    uint maxRedeemableLUSD = LiquityMath._min(remainingLUSD, netLUSDDebt.sub(MIN_NET_DEBT));

                    uint ETH = troveManager.getTroveColl(currentTroveuser)
                        .add(rewards.getPendingCollateralReward(currentTroveuser));

                    uint newColl = ETH.sub(maxRedeemableLUSD.mul(par).div(_price));
                    uint newDebt = netLUSDDebt.sub(maxRedeemableLUSD);

                    uint compositeDebt = _getCompositeDebt(newDebt);

                    uint256 nCompositeDebt = troveManager.shielded(currentTroveuser) ?
                        _normalizedDebt(compositeDebt, accShieldRate) : _normalizedDebt(compositeDebt, accRate);

                    partialRedemptionHintNICR = LiquityMath._computeNominalCR(newColl, nCompositeDebt);

                    remainingLUSD = remainingLUSD.sub(maxRedeemableLUSD);
                }
                break;
            } else {
                remainingLUSD = remainingLUSD.sub(netLUSDDebt);
            }

            currentTroveuser = sortedTrovesCached.getPrev(currentTroveuser);
        }

        truncatedLUSDamount = _LUSDamount.sub(remainingLUSD);
    }
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
        vars.par = relayer.par();
        vars.remainingLUSD = _LUSDamount;
        if (_maxIterations == 0) { _maxIterations = type(uint).max; }

        // --- seed: first redeemable in BASE (ICR ≥ MCR) ---
        vars.curBase = sortedTroves.getLast();
        while (vars.curBase != address(0) && troveManager.getCurrentICR(vars.curBase, _price) < MCR) {
            vars.curBase = sortedTroves.getPrev(vars.curBase); // prev => larger ICR
        }

        // --- seed: first redeemable in SHIELDED (MCR ≤ ICR < HCR) ---
        vars.curSh = sortedShieldedTroves.getLast();
        while (vars.curSh != address(0)) {
            uint icrS = troveManager.getCurrentICR(vars.curSh, _price);
            if (icrS >= MCR) { if (icrS < HCR) { break; } else { vars.curSh = address(0); break; } }
            vars.curSh = sortedShieldedTroves.getPrev(vars.curSh);
        }

        // decide the very first hint (lower eligible ICR wins; tie → base)
        {
            uint icrB = vars.curBase == address(0) ? type(uint).max : troveManager.getCurrentICR(vars.curBase, _price);
            uint icrS = vars.curSh   == address(0) ? type(uint).max : troveManager.getCurrentICR(vars.curSh,   _price);
            if (icrB == type(uint).max && icrS == type(uint).max) {
                // no redeemables at all
                return (address(0), 0, 0);
            }
            firstRedemptionHint = (icrB <= icrS) ? vars.curBase : vars.curSh;
        }

        // accumulators for NICR math
        vars.accRate      = troveManager.accumulatedRate();
        vars.accShieldRate= troveManager.accumulatedShieldRate();

        // --- merged walk to find partial NICR and truncated amount ---
        while (vars.remainingLUSD > 0 && _maxIterations-- > 0 && (vars.curBase != address(0) || vars.curSh != address(0))) {
            // compute eligible ICRs for current heads
            uint icrB = type(uint).max;
            uint icrS = type(uint).max;

            if (vars.curBase != address(0)) {
                uint b = troveManager.getCurrentICR(vars.curBase, _price);
                if (b >= MCR) icrB = b;
            }
            if (vars.curSh != address(0)) {
                uint s = troveManager.getCurrentICR(vars.curSh, _price);
                if (s >= MCR && s < HCR) icrS = s;
            }
            if (icrB == type(uint).max && icrS == type(uint).max) { break; }

            bool pickBase = (icrB <= icrS);
            address who = pickBase ? vars.curBase : vars.curSh;

            // actual net debt (your helper already accounts for rewards in "actual" space)
            uint netLUSDDebt = _getNetDebt(troveManager.getTroveActualDebt(who))
                .add(troveManager.getPendingActualLUSDDebtReward(who));

            if (netLUSDDebt > vars.remainingLUSD) {
                // this is the partial trove (if any)
                if (netLUSDDebt > MIN_NET_DEBT) {
                    uint maxRedeemableLUSD = LiquityMath._min(vars.remainingLUSD, netLUSDDebt.sub(MIN_NET_DEBT));

                    uint coll = troveManager.getTroveColl(who)
                        .add(rewards.getPendingCollateralReward(who));

                    uint newColl = coll.sub(maxRedeemableLUSD.mul(vars.par).div(_price));
                    uint newDebt = netLUSDDebt.sub(maxRedeemableLUSD);
                    uint compositeDebt = _getCompositeDebt(newDebt);

                    // pick the right accumulator for this trove’s class
                    bool isSh = troveManager.shielded(who);
                    uint nCompositeDebt = isSh
                        ? _normalizedDebt(compositeDebt, vars.accShieldRate)
                        : _normalizedDebt(compositeDebt, vars.accRate);

                    partialRedemptionHintNICR = LiquityMath._computeNominalCR(newColl, nCompositeDebt);

                    vars.remainingLUSD = vars.remainingLUSD.sub(maxRedeemableLUSD);
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

    /**
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
        uint arrayLength;
        //address (*ownerAt)(ITroveManagerLike, uint) pure returns (address);
        ISortedTroves list = _shielded ? sortedShieldedTroves : sortedTroves;

        if (_shielded) {
            arrayLength = troveManager.getShieldedTroveOwnersCount();
        } else {
            arrayLength = troveManager.getTroveOwnersCount();
        }

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

        uint tB = (tot == 0 || numTrials == 0) ? 0 : (numTrials * nB) / tot;
        uint tS = (tot == 0 || numTrials == 0) ? 0 : (numTrials - tB);
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
        // Allocate trials across lists (proportional to sizes, but at least 1 if non-empty).
        /*
        uint nB = sortedTroves.getSize();
        uint nS = sortedShieldedTroves.getSize();
        uint tot = nB + nS;

        uint tB = (tot == 0 || numTrials == 0) ? 0 : (numTrials * nB) / tot;
        uint tS = (tot == 0 || numTrials == 0) ? 0 : (numTrials - tB);
        if (nB > 0 && tB == 0) tB = 1;
        if (nS > 0 && tS == 0) tS = 1;
        */

        (uint tB, uint tS) = _getTrials(sortedTroves.getSize(), sortedShieldedTroves.getSize(), numTrials);

        address approxB;
        address approxS;
        (approxB,,seedOut) = _approxOnList(sortedTroves, targetNICR, tB, seed);
        (approxS,,seedOut) = _approxOnList(sortedShieldedTroves, targetNICR, tS, seed);

        // Compute exact neighbors on each list using its own hint
        (upperBase,   lowerBase)   = _find(sortedTroves,   targetNICR, approxB);
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
        //bestDiff = Abs.diff(troveManager.getNominalICR(best), targetNICR);
        bestDiff = LiquityMath._getAbsoluteDifference(troveManager.getNominalICR(best), targetNICR);
        seedOut = seed;

        for (uint i = 1; i < trials; i++) {
            seedOut = uint(keccak256(abi.encodePacked(seedOut)));
            uint steps = seedOut % n;
            address node = list.getLast();
            while (steps > 0 && node != address(0)) { node = list.getPrev(node); steps--; }
            if (node == address(0)) continue;

            //uint d = Abs.diff(troveManager.getNominalICR(node), targetNICR);
            uint d = LiquityMath._getAbsoluteDifference(troveManager.getNominalICR(node), targetNICR);
            if (d < bestDiff) {
                best = node;
                bestDiff = d;
            }
        }
    }

    /* getApproxHint() - return address of a Trove that is, on average, (length / numTrials) positions away in the 
    sortedTroves list from the correct insert position of the Trove to be inserted. 
    
    Note: The output address is worst-case O(n) positions away from the correct insert position, however, the function 
    is probabilistic. Input can be tuned to guarantee results to a high degree of confidence, e.g:

    Submitting numTrials = k * sqrt(length), with k = 15 makes it very, very likely that the ouput address will 
    be <= sqrt(length) positions away from the correct insert position.
    */
    /*
    function getApproxHint(uint _CR, uint _numTrials, uint _inputRandomSeed)
        external
        view
        returns (address hintAddress, uint diff, uint latestRandomSeed)
    {
        uint arrayLength = troveManager.getTroveOwnersCount();

        if (arrayLength == 0) {
            return (address(0), 0, _inputRandomSeed);
        }

        hintAddress = sortedTroves.getLast();
        diff = LiquityMath._getAbsoluteDifference(_CR, troveManager.getNominalICR(hintAddress));
        latestRandomSeed = _inputRandomSeed;

        uint i = 1;

        while (i < _numTrials) {
            latestRandomSeed = uint(keccak256(abi.encodePacked(latestRandomSeed)));

            uint arrayIndex = latestRandomSeed % arrayLength;
            address currentAddress = troveManager.getTroveFromTroveOwnersArray(arrayIndex);
            uint currentNICR = troveManager.getNominalICR(currentAddress);

            // check if abs(current - CR) > abs(closest - CR), and update closest if current is closer
            uint currentDiff = LiquityMath._getAbsoluteDifference(currentNICR, _CR);

            if (currentDiff < diff) {
                diff = currentDiff;
                hintAddress = currentAddress;
            }
            i++;
        }
    }   
    */

    function computeNominalCR(uint _coll, uint _debt) external pure returns (uint) {
        return LiquityMath._computeNominalCR(_coll, _debt);
    }

    function computeCR(uint _coll, uint _debt, uint _price) external view returns (uint) {
        uint par = relayer.par();
        return LiquityMath._computeCR(_coll, _debt, _price, par);
    }
}
