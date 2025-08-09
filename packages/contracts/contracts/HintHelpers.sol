// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
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

    // --- Events ---

    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event TroveManagerAddressChanged(address _troveManagerAddress);
    event RelayerAddressChanged(address _relayerAddress);

    // --- Dependency setters ---

    function setAddresses(
        address _sortedTrovesAddress,
        address _sortedShieldedTrovesAddress,
        address _troveManagerAddress,
        address _relayerAddress
    )
        external
        onlyOwner
    {
        checkContract(_sortedTrovesAddress);
        checkContract(_troveManagerAddress);
        checkContract(_relayerAddress);

        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        sortedShieldedTroves = ISortedTroves(_sortedTrovesAddress);
        troveManager = ITroveManager(_troveManagerAddress);
        relayer = IRelayer(_relayerAddress);

        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
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
                        .add(troveManager.getPendingCollateralReward(currentTroveuser));

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
        uint par = relayer.par();
        uint remainingLUSD = _LUSDamount;
        if (_maxIterations == 0) { _maxIterations = type(uint).max; }

        // --- seed: first redeemable in BASE (ICR ≥ MCR) ---
        address curBase = sortedTroves.getLast();
        while (curBase != address(0) && troveManager.getCurrentICR(curBase, _price) < MCR) {
            curBase = sortedTroves.getPrev(curBase); // prev => larger ICR
        }

        // --- seed: first redeemable in SHIELDED (MCR ≤ ICR < HCR) ---
        address curSh = sortedShieldedTroves.getLast();
        while (curSh != address(0)) {
            uint icrS = troveManager.getCurrentICR(curSh, _price);
            if (icrS >= MCR) { if (icrS < HCR) { break; } else { curSh = address(0); break; } }
            curSh = sortedShieldedTroves.getPrev(curSh);
        }

        // decide the very first hint (lower eligible ICR wins; tie → base)
        {
            uint icrB = curBase == address(0) ? type(uint).max : troveManager.getCurrentICR(curBase, _price);
            uint icrS = curSh   == address(0) ? type(uint).max : troveManager.getCurrentICR(curSh,   _price);
            if (icrB == type(uint).max && icrS == type(uint).max) {
                // no redeemables at all
                return (address(0), 0, 0);
            }
            firstRedemptionHint = (icrB <= icrS) ? curBase : curSh;
        }

        // accumulators for NICR math
        uint accRate      = troveManager.accumulatedRate();
        uint accShieldRate= troveManager.accumulatedShieldRate();

        // --- merged walk to find partial NICR and truncated amount ---
        while (remainingLUSD > 0 && _maxIterations-- > 0 && (curBase != address(0) || curSh != address(0))) {
            // compute eligible ICRs for current heads
            uint icrB = type(uint).max;
            uint icrS = type(uint).max;

            if (curBase != address(0)) {
                uint b = troveManager.getCurrentICR(curBase, _price);
                if (b >= MCR) icrB = b;
            }
            if (curSh != address(0)) {
                uint s = troveManager.getCurrentICR(curSh, _price);
                if (s >= MCR && s < HCR) icrS = s;
            }
            if (icrB == type(uint).max && icrS == type(uint).max) { break; }

            bool pickBase = (icrB <= icrS);
            address who = pickBase ? curBase : curSh;

            // actual net debt (your helper already accounts for rewards in "actual" space)
            uint netLUSDDebt = _getNetDebt(troveManager.getTroveActualDebt(who))
                .add(troveManager.getPendingActualLUSDDebtReward(who));

            if (netLUSDDebt > remainingLUSD) {
                // this is the partial trove (if any)
                if (netLUSDDebt > MIN_NET_DEBT) {
                    uint maxRedeemableLUSD = LiquityMath._min(remainingLUSD, netLUSDDebt.sub(MIN_NET_DEBT));

                    uint coll = troveManager.getTroveColl(who)
                        .add(troveManager.getPendingCollateralReward(who));

                    uint newColl = coll.sub(maxRedeemableLUSD.mul(par).div(_price));
                    uint newDebt = netLUSDDebt.sub(maxRedeemableLUSD);
                    uint compositeDebt = _getCompositeDebt(newDebt);

                    // pick the right accumulator for this trove’s class
                    bool isSh = troveManager.shielded(who);
                    uint nCompositeDebt = isSh
                        ? _normalizedDebt(compositeDebt, accShieldRate)
                        : _normalizedDebt(compositeDebt, accRate);

                    partialRedemptionHintNICR = LiquityMath._computeNominalCR(newColl, nCompositeDebt);

                    remainingLUSD = remainingLUSD.sub(maxRedeemableLUSD);
                }
                break; // done: either we consumed all or we found partial and exit
            } else {
                // full redemption of this trove
                remainingLUSD = remainingLUSD.sub(netLUSDDebt);
                // advance only the chosen list
                if (pickBase) curBase = sortedTroves.getPrev(who);
                else          curSh   = sortedShieldedTroves.getPrev(who);
            }
        }

        truncatedLUSDamount = _LUSDamount.sub(remainingLUSD);
    }

    /* getApproxHint() - return address of a Trove that is, on average, (length / numTrials) positions away in the 
    sortedTroves list from the correct insert position of the Trove to be inserted. 
    
    Note: The output address is worst-case O(n) positions away from the correct insert position, however, the function 
    is probabilistic. Input can be tuned to guarantee results to a high degree of confidence, e.g:

    Submitting numTrials = k * sqrt(length), with k = 15 makes it very, very likely that the ouput address will 
    be <= sqrt(length) positions away from the correct insert position.
    */
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

    function computeNominalCR(uint _coll, uint _debt) external pure returns (uint) {
        return LiquityMath._computeNominalCR(_coll, _debt);
    }

    function computeCR(uint _coll, uint _debt, uint _price) external view returns (uint) {
        uint par = relayer.par();
        return LiquityMath._computeCR(_coll, _debt, _price, par);
    }
}
