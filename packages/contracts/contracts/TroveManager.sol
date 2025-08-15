// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
import "./Interfaces/ILiquidations.sol";
import "./Interfaces/IAggregator.sol";
import "./Interfaces/IStabilityPool.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ILUSDToken.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/ILQTYToken.sol";
import "./Interfaces/ILQTYStaking.sol";
import "./Interfaces/IRelayer.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/CheckContract.sol";
//import "./Dependencies/console.sol";

/*
library Str {
    function utoa(uint256 v) internal pure returns (string memory s) {
        if (v == 0) return "0";
        uint256 j=v; uint256 len;
        while (j != 0) { len++; j/=10; }
        bytes memory b = new bytes(len);
        j = v;
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v/=10; }
        return string(b);
    }
    function addr(address a) internal pure returns (string memory) {
        bytes32 b = bytes32(uint256(uint160(a)));
        bytes memory hexChars = "0123456789abcdef";
        bytes memory s = new bytes(2 + 40);
        s[0] = '0'; s[1] = 'x';
        for (uint i=0; i<20; i++) {
            s[2+i*2]   = hexChars[uint8(b[i+12] >> 4)];
            s[3+i*2]   = hexChars[uint8(b[i+12] & 0x0f)];
        }
        return string(s);
    }
}
*/

contract TroveManager is LiquityBase, Ownable, CheckContract, ITroveManager {
    //string constant public NAME = "TroveManager";

    // --- Connected contract declarations ---

    IAggregator public aggregator;

    IRewards public rewards;

    ILiquidations public liquidations;

    address public borrowerOperationsAddress;

    IStabilityPool public override stabilityPool;

    address gasPoolAddress;

    ICollSurplusPool public override collSurplusPool;

    ILUSDToken public override lusdToken;

    ILQTYToken public override lqtyToken;

    ILQTYStaking public override lqtyStaking;

    // A doubly linked list of Troves, sorted by their collateral ratios
    ISortedTroves public sortedTroves;

    // A doubly linked list of Shielded Troves, sorted by their collateral ratios
    ISortedTroves public sortedShieldedTroves;

    uint internal constant REDEMPTION_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%

    uint internal constant DRIP_STALENESS_THRESHOLD = 1 hours;

    //uint internal constant kappa = 15 * 10**17; // 1.5
    uint internal constant kappa = 10**18; // 1.5

    uint public constant stakeRevenueAllocation = 25*10**16; // 25%

    // During bootsrap period redemptions are not allowed
    uint internal constant BOOTSTRAP_PERIOD = 14 days;

    // accumulated interest rate
    uint public override accumulatedRate = RATE_PRECISION;

    // accumulated interest rate for shielded troves
    uint public override accumulatedShieldRate = RATE_PRECISION;

    uint public lastAccRateUpdateTime = block.timestamp;

    enum Status {
        nonExistent,
        active,
        closedByOwner,
        closedByLiquidation,
        closedByRedemption
    }

    // Store the necessary data for a trove
    struct Trove {
        uint debt;
        uint coll;
        uint stake;
        Status status;
        uint128 arrayIndex;
    }

    struct RedemptionHints {
        address upperHint;
        address lowerHint;
        address upperShieldedHint;
        address lowerShieldedHint;
        uint256 partialNICR;
    }

    mapping (address => Trove) public Troves;
    mapping (address => bool) public override shielded;

    // Array of all active trove addresses - used to to compute an approximate hint off-chain, for the sorted list insertion
    address[] public TroveOwners;
    address[] public ShieldedTroveOwners;

    struct ContractsCache {
        IActivePool activePool;
        IActivePool activeShieldedPool;
        IDefaultPool defaultPool;
        IDefaultPool defaultShieldedPool;
        ILUSDToken lusdToken;
        ILQTYStaking lqtyStaking;
        ISortedTroves sortedTroves;
        ISortedTroves sortedShieldedTroves;
        ICollSurplusPool collSurplusPool;
        address gasPoolAddress;
    }
    // --- Variable container structs for redemptions ---

    struct RedemptionTotals {
        uint remainingLUSD;
        uint totalLUSDToRedeem;
        uint totalLUSDToRedeemShielded;
        uint totalCollateralDrawn;
        uint collateralFee;
        uint collateralToSendToRedeemer;
    }

    struct RedemptionLocals {
        uint decayedBaseRate;
        uint price;
        uint par;
        uint totalLUSDSupplyAtStart;
        address curBase;
        address curSh;
        address currentBorrower;
        address nextUserToCheck;
        bool pickBase;
    }

    struct SingleRedemptionValues {
        uint LUSDLot;
        uint collateralLot;
        bool cancelledPartial;
    }

    // --- Events ---
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint _stake, TroveManagerOperation _operation);
    event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, TroveManagerOperation _operation);
    event Drip(uint256 _stakeInterest, uint256 _spInterest);

     enum TroveManagerOperation {
        applyPendingRewards,
        liquidate,
        redeemCollateral
    }

    // --- Dependency setter ---

    function setAddresses(
        address[] memory addresses
    )
        external
        override
        onlyOwner
    {
        for (uint i = 0; i < addresses.length; i++) {
            checkContract(addresses[i]);
        }

        aggregator = IAggregator(addresses[0]);
        liquidations = ILiquidations(addresses[1]);
        borrowerOperationsAddress = addresses[2];
        activePool = IActivePool(addresses[3]);
        activeShieldedPool = IActivePool(addresses[4]);
        defaultPool = IDefaultPool(addresses[5]);
        defaultShieldedPool = IDefaultPool(addresses[6]);
        stabilityPool = IStabilityPool(addresses[7]);
        gasPoolAddress = addresses[8];
        collSurplusPool = ICollSurplusPool(addresses[9]);
        priceFeed = IPriceFeed(addresses[10]);
        lusdToken = ILUSDToken(addresses[11]);
        sortedTroves = ISortedTroves(addresses[12]);
        sortedShieldedTroves = ISortedTroves(addresses[13]);
        lqtyToken = ILQTYToken(addresses[14]);
        lqtyStaking = ILQTYStaking(addresses[15]);
        relayer = IRelayer(addresses[16]);
        IERC20 collateralToken = IERC20(addresses[17]);
        rewards = IRewards(addresses[18]);

        assert(address(collateralToken) != address(0));
        
        collateralToken.approve(address(activePool), type(uint256).max);

        emit AggregatorAddressChanged(address(aggregator));
        emit LiquidationsAddressChanged(address(liquidations));
        emit BorrowerOperationsAddressChanged(borrowerOperationsAddress);
        emit ActivePoolAddressChanged(address(activePool));
        emit ActiveShieldedPoolAddressChanged(address(activeShieldedPool));
        emit DefaultPoolAddressChanged(address(defaultPool));
        emit DefaultShieldedPoolAddressChanged(address(defaultShieldedPool));
        emit StabilityPoolAddressChanged(address(stabilityPool));
        emit GasPoolAddressChanged(gasPoolAddress);
        emit CollSurplusPoolAddressChanged(address(collSurplusPool));
        emit PriceFeedAddressChanged(address(priceFeed));
        emit LUSDTokenAddressChanged(address(lusdToken));
        emit SortedTrovesAddressChanged(address(sortedTroves));
        emit SortedShieldedTrovesAddressChanged(address(sortedShieldedTroves));
        emit LQTYTokenAddressChanged(address(lqtyToken));
        emit LQTYStakingAddressChanged(address(lqtyStaking));
        emit RelayerAddressChanged(address(relayer));

        _renounceOwnership();
    }

    // --- Getters ---

    function getTroveOwnersCount() external view override returns (uint) {
        return TroveOwners.length;
    }

    function getTroveFromTroveOwnersArray(uint _index) external view override returns (address) {
        return TroveOwners[_index];
    }

    function getShieldedTroveOwnersCount() external view override returns (uint) {
        return ShieldedTroveOwners.length;
    }

    function getTroveFromShieldedTroveOwnersArray(uint _index) external view override returns (address) {
        return ShieldedTroveOwners[_index];
    }

    // --- Redemption functions ---

    // Redeem as much collateral as possible from _borrower's Trove in exchange for LUSD up to _maxLUSDamount
    function _redeemCollateralFromTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint _maxLUSDamount,
        uint _price,
        uint _par,
        RedemptionHints memory hints,
        bool _shielded
    )
        internal returns (SingleRedemptionValues memory singleRedemption)
    {

        // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the Trove minus the liquidation reserve
        singleRedemption.LUSDLot = LiquityMath._min(_maxLUSDamount, _actualDebt(Troves[_borrower].debt, _shielded).sub(LUSD_GAS_COMPENSATION));

        // Get the collateralLot of equivalent value in USD
        singleRedemption.collateralLot = singleRedemption.LUSDLot.mul(_par).div(_price);

        uint normDebt = _normalizedDebt(singleRedemption.LUSDLot, _shielded);

        if (_actualDebt(normDebt, _shielded) < _actualDebt(singleRedemption.LUSDLot, _shielded)) {
            normDebt += 1;
        }

        // Decrease the debt and collateral of the current Trove according to the LUSD lot and corresponding collateral to send
        uint newDebt = (Troves[_borrower].debt).sub(normDebt);
        uint newColl = (Troves[_borrower].coll).sub(singleRedemption.collateralLot);

        // Change from eq to lte
        // since sub of normalized debt above could make 1 wei less
        // and actualDebt can also round down
        //if (_actualDebt(newDebt).sub(1) <= LUSD_GAS_COMPENSATION) {
        if (_actualDebt(newDebt, _shielded) <= LUSD_GAS_COMPENSATION) {
            // No debt left in the Trove (except for the liquidation reserve), therefore the trove gets closed
            rewards.removeStake(_borrower);
            _closeTrove(_borrower, Status.closedByRedemption);
            _redeemCloseTrove(_contractsCache, _borrower, LUSD_GAS_COMPENSATION, newColl, _shielded);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.redeemCollateral);

        } else {
            // TODO uncomment and fix stack too deep
            //uint newNICR = LiquityMath._computeNominalCR(newColl, newDebt);

            /*
            * If the provided hint is out of date, we bail since trying to reinsert without a good hint will almost
            * certainly result in running out of gas. 
            *
            * If the resultant net debt of the partial is less than the minimum, net debt we bail.
            */
            if (LiquityMath._computeNominalCR(newColl, newDebt) != hints.partialNICR || _getNetDebt(_actualDebt(newDebt, _shielded)) < MIN_NET_DEBT) {
                //emit PartialNicr(_borrower, newNICR, _actualDebt(newDebt));
                singleRedemption.cancelledPartial = true;
                return singleRedemption;
            }

            if (_shielded) {
                _contractsCache.sortedShieldedTroves.reInsert(_borrower, LiquityMath._computeNominalCR(newColl, newDebt), hints.upperShieldedHint, hints.lowerShieldedHint);
            } else {
                _contractsCache.sortedTroves.reInsert(_borrower, LiquityMath._computeNominalCR(newColl, newDebt), hints.upperHint, hints.lowerHint);
            }

            Troves[_borrower].debt = newDebt;
            Troves[_borrower].coll = newColl;
            rewards.updateStakeAndTotalStakes(_borrower);

            emit TroveUpdated(
                _borrower,
                newDebt, newColl,
                Troves[_borrower].stake,
                TroveManagerOperation.redeemCollateral
            );
        }

        return singleRedemption;
    }

    /*
    * Called when a full redemption occurs, and closes the trove.
    * The redeemer swaps (debt - liquidation reserve) LUSD for (debt - liquidation reserve) worth of collateral, so the LUSD liquidation reserve left corresponds to the remaining debt.
    * In order to close the trove, the LUSD liquidation reserve is burned, and the corresponding debt is removed from the active pool.
    * The debt recorded on the trove's struct is zero'd elswhere, in _closeTrove.
    * Any surplus collateral left in the trove, is sent to the Coll surplus pool, and can be later claimed by the borrower.
    */
    function _redeemCloseTrove(ContractsCache memory _contractsCache, address _borrower, uint _LUSD, uint _collateral, bool _shielded) internal {
        _contractsCache.lusdToken.burn(gasPoolAddress, _LUSD);
        // Update Active Pool LUSD, and send collateral to account
        // subtract 1 more to ensure debt <= supply
        /*
        uint normDebt = _normalizedDebt(_LUSD);
        if (normDebt.mul(accumulatedRate).div(RATE_PRECISION) < _actualDebt(_LUSD)) {
            normDebt += 1;
        }
        _contractsCache.activePool.decreaseLUSDDebt(normDebt);
        */


        // always round up to ensure no dust
        if (_shielded) {
            _contractsCache.activeShieldedPool.decreaseLUSDDebt(_normalizedDebt(_LUSD, _shielded));
        } else {
            _contractsCache.activePool.decreaseLUSDDebt(_normalizedDebt(_LUSD, _shielded));
        }

        // send collateral from Active Pool to CollSurplus Pool
        _contractsCache.collSurplusPool.accountSurplus(_borrower, _collateral);
        _contractsCache.activePool.sendCollateral(address(_contractsCache.collSurplusPool), _collateral);
    }

    /*
    // currently unused
    function _hasAnyRedeemable(uint price) internal view returns (bool) {
        address b = sortedTroves.getLast();
        if (b != address(0) && getCurrentICR(b, price) >= MCR) return true;

        address s = sortedShieldedTroves.getLast();
        if (s != address(0)) {
            uint icrS = getCurrentICR(s, price);
            if (icrS >= MCR && icrS < HCR) return true;
        }

        return false;
    }
    */

    /*
    function seedBase(ISortedTroves s, uint price) internal view returns (address cur) {
        cur = s.getLast();
        while (cur != address(0)) {
            uint icr = getCurrentICR(cur, price);
            if (icr >= MCR) break;          // first redeemable in base list
            cur = s.getPrev(cur);           // prev => next larger ICR
        }
        // if cur==0 => none redeemable
    }

    function seedShielded(ISortedTroves s, uint price) internal view returns (address cur) {
        cur = s.getLast();
        while (cur != address(0)) {
            uint icr = getCurrentICR(cur, price);
            if (icr >= MCR) {
                if (icr < HCR) return cur;  // first redeemable shielded
                return address(0);          // hit >=HCR first: no shielded redeemables
            }
            cur = s.getPrev(cur);           // prev => next larger ICR
        }
        // if cur==0 => none redeemable
    }
    */

    // --- redeemCollateral() helpers ---------------------------------------------------------------
    function _validateFirstHint(address _first, uint256 _price, uint256 _par)
        internal
        view
        returns (bool ok, bool isShieldedList)
    {
        if (_first == address(0)) return (false, false);

        // Base list
        if (sortedTroves.contains(_first)) {
            uint256 icr = _getCurrentICR(_first, _price, _par);
            if (icr < MCR) return (false, false);

            address next = sortedTroves.getNext(_first); // next => lower ICR
            if (next == address(0)) return (true, false);
            if (_getCurrentICR(next, _price, _par) < MCR) return (true, false);
            return (false, false);
        }

        // Shielded list
        if (sortedShieldedTroves.contains(_first)) {
            uint256 icr = _getCurrentICR(_first, _price, _par);
            // shielded redeemable only in [MCR, HCR)
            if (icr < MCR || icr >= HCR) return (false, true);

            address next = sortedShieldedTroves.getNext(_first);
            if (next == address(0)) return (true, true);
            if (_getCurrentICR(next, _price, _par) < MCR) return (true, true);
            return (false, true);
        }

        return (false, false);
    }

    function _seedCursorsFromHint(address _firstHint, uint256 _price, uint256 _par)
        internal
        view
        returns (address curBase, address curSh)
    {
        // 1) Try to use the provided hint (resolve membership first)
        if (_firstHint != address(0)) {
            (bool ok, bool isSh) = _validateFirstHint(_firstHint, _price, _par);
            if (ok) {
                if (isSh) curSh = _firstHint;
                else      curBase = _firstHint;
            }
        }

        // 2) Seed BASE cursor if missing w/ first ICR ≥ MCR
        if (curBase == address(0)) {
            address n = sortedTroves.getLast();
            while (n != address(0)) {
                uint256 icr = _getCurrentICR(n, _price, _par);
                if (icr >= MCR) { curBase = n; break; }
                n = sortedTroves.getPrev(n); // prev => larger ICR
            }
        }

        // 3) Seed SHIELDED cursor if missing w/ first MCR ≤ ICR < HCR
        if (curSh == address(0)) {
            address n = sortedShieldedTroves.getLast();
            while (n != address(0)) {
                uint256 icr = _getCurrentICR(n, _price, _par);
                if (icr >= MCR) { curSh = (icr < HCR) ? n : address(0); break; }
                n = sortedShieldedTroves.getPrev(n); // prev => larger ICR
            }
        }
    }

    function redeemCollateral(
        uint _LUSDamount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        address _upperShieldedPartialRedemptionHint,
        address _lowerShieldedPartialRedemptionHint,
        uint _partialRedemptionHintNICR,
        uint _maxIterations,
        uint _maxFeePercentage
    )
        external
        override
    {
        ContractsCache memory contractsCache = ContractsCache(
            activePool,
            activeShieldedPool,
            defaultPool,
            defaultShieldedPool,
            lusdToken,
            lqtyStaking,
            sortedTroves,     // kept for compatibility; not used below once split lists exist
            sortedShieldedTroves,     // kept for compatibility; not used below once split lists exist
            collSurplusPool,
            gasPoolAddress
        );
        RedemptionTotals memory totals;
        RedemptionLocals memory locals;
        RedemptionHints memory hints;

        _requireValidMaxFeePercentage(_maxFeePercentage);
        _requireAfterBootstrapPeriod();

        locals.price = priceFeed.fetchPrice();
        //uint interestRate;
        (, locals.par) = relayer.updateRateAndPar();
        // _drip(interestRate); // still disabled per your note

        _requireTCRoverMCR(locals.price);
        require(_LUSDamount > 0, "TroveManager: Amount must be greater than zero");
        _requireLUSDBalanceCoversRedemption(contractsCache.lusdToken, msg.sender, _LUSDamount);

        locals.totalLUSDSupplyAtStart = getEntireSystemDebt(accumulatedRate, accumulatedShieldRate);
        assert(contractsCache.lusdToken.balanceOf(msg.sender) <= locals.totalLUSDSupplyAtStart);

        totals.remainingLUSD = _LUSDamount;

        // --- seed cursors from hint or by scanning tails (base + shielded) ---
        (locals.curBase, locals.curSh) = _seedCursorsFromHint(_firstRedemptionHint, locals.price, locals.par);

        // --- merged redemption loop ---
        if (_maxIterations == 0) { _maxIterations = uint(-1); }

        while (totals.remainingLUSD > 0 && _maxIterations > 0 && (locals.curBase != address(0) || locals.curSh != address(0))) {
            _maxIterations--;

            // get redemption candidates
            uint icrB = type(uint).max;
            uint icrS = type(uint).max;

            if (locals.curBase != address(0)) {
                uint b = _getCurrentICR(locals.curBase, locals.price, locals.par);
                if (b >= MCR) icrB = b; // else no longer redeemable
            }

            if (locals.curSh != address(0)) {
                uint s = _getCurrentICR(locals.curSh, locals.price, locals.par);
                if (s >= MCR && s < HCR) icrS = s; // shielded only in [MCR, HCR)
            }

            // stop if neither candidate is eligible
            if (icrB == type(uint).max && icrS == type(uint).max) { break; }

            // pick lower-ICR eligible; tie -> prefer BASE
            locals.pickBase = (icrB <= icrS);
            locals.currentBorrower = locals.pickBase ? locals.curBase : locals.curSh;

            // Save next pointer for the chosen list (prev => larger ICR)
            locals.nextUserToCheck = locals.pickBase
                ? sortedTroves.getPrev(locals.currentBorrower)
                : sortedShieldedTroves.getPrev(locals.currentBorrower);

            // Apply pending rewards *for this borrower only*
            rewards.applyPendingRewards(locals.currentBorrower);

            // Hints object (addresses+NICR unchanged ABI)
            hints = RedemptionHints(
                _upperPartialRedemptionHint,
                _lowerPartialRedemptionHint,
                _upperShieldedPartialRedemptionHint,
                _lowerShieldedPartialRedemptionHint,
                _partialRedemptionHintNICR
            );

            // Redeem from the chosen borrower
            //bool isShieldedBorrower = !locals.pickBase;
            SingleRedemptionValues memory singleRedemption = _redeemCollateralFromTrove(
                contractsCache,
                locals.currentBorrower,
                totals.remainingLUSD,
                locals.price,
                locals.par,
                hints,
                !locals.pickBase
            );

            if (singleRedemption.cancelledPartial) { break; }

            if (!locals.pickBase) {
                totals.totalLUSDToRedeemShielded = totals.totalLUSDToRedeemShielded.add(singleRedemption.LUSDLot);
            } else {
                totals.totalLUSDToRedeem = totals.totalLUSDToRedeem.add(singleRedemption.LUSDLot);
            }

            totals.totalCollateralDrawn = totals.totalCollateralDrawn.add(singleRedemption.collateralLot);
            totals.remainingLUSD = totals.remainingLUSD.sub(singleRedemption.LUSDLot);

            // advance only the list we consumed from
            if (locals.pickBase) {
                locals.curBase = locals.nextUserToCheck;
            } else {
                locals.curSh = locals.nextUserToCheck;
            }
        }

        /*
        require(
            false, 
            string(abi.encodePacked(
                "totals.totalLUSDToRedeem=", Str.utoa(totals.totalLUSDToRedeem),
                "norm totals.totalLUSDToRedeem=", Str.utoa(_normalizedDebt(totals.totalLUSDToRedeem, false)),
                "LUSDDebt", Str.utoa(activePool.getLUSDDebt()),
                "totals.totalLUSDToRedeemShielded=", Str.utoa(totals.totalLUSDToRedeemShielded)
            ))
        );
        */

        require(totals.totalCollateralDrawn > 0, "TroveManager: Unable to redeem any amount");

        uint totalRedeemed = totals.totalLUSDToRedeem.add(totals.totalLUSDToRedeemShielded);

        // Base rate update and fee
        aggregator.updateBaseRateFromRedemption(
            totals.totalCollateralDrawn, locals.price, locals.par, locals.totalLUSDSupplyAtStart
        );

        totals.collateralFee = aggregator.getRedemptionFee(totals.totalCollateralDrawn);
        _requireUserAcceptsFee(totals.collateralFee, totals.totalCollateralDrawn, _maxFeePercentage);

        // Distribute fees and collateral
        contractsCache.activePool.sendCollateral(address(contractsCache.lqtyStaking), totals.collateralFee);
        contractsCache.lqtyStaking.increaseF_Collateral(totals.collateralFee);

        totals.collateralToSendToRedeemer = totals.totalCollateralDrawn.sub(totals.collateralFee);

        emit Redemption(_LUSDamount, totalRedeemed, totals.totalCollateralDrawn, totals.collateralFee);

        contractsCache.lusdToken.burn(msg.sender, totalRedeemed);

        if (totals.totalLUSDToRedeem > 0) {
            contractsCache.activePool.decreaseLUSDDebt(_normalizedDebt(totals.totalLUSDToRedeem, false));
        }
        if (totals.totalLUSDToRedeemShielded > 0) {
            contractsCache.activeShieldedPool.decreaseLUSDDebt(_normalizedDebt(totals.totalLUSDToRedeemShielded, true));
        }
        contractsCache.activePool.sendCollateral(msg.sender, totals.collateralToSendToRedeemer);
    }

    // --- Helper functions ---

    // Return the nominal collateral ratio (ICR) of a given Trove, without the price. Takes a trove's pending coll and debt rewards from redistributions into account.
    // TODO adjust for shielded
    function getNominalICR(address _borrower) public view override returns (uint) {
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_borrower);

        uint NICR = LiquityMath._computeNominalCR(currentCollateral, currentLUSDDebt);
        return NICR;
    }

    // Return the current collateral ratio (ICR) of a given Trove. Takes a trove's pending coll and debt rewards from redistributions into account.
    function getCurrentICR(address _borrower, uint _price) public view override returns (uint) {
        uint par = relayer.par();
        return _getCurrentICR(_borrower, _price, par);
    }

    function _getCurrentICR(address _borrower, uint _price, uint _par) internal view returns (uint) {
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_borrower);
        uint ICR = LiquityMath._computeCR(currentCollateral, _actualDebt(currentLUSDDebt, shielded[_borrower]), _price, _par);
        return ICR;
    }

    // return debts in norm of trove(shielded or unshielded)
    function _getCurrentTroveAmounts(address _borrower) internal view returns (uint, uint) {

        // Compute and apply pending collateral rewards
        uint pendingCollateralReward = rewards.getPendingCollateralReward(_borrower);
        uint currentCollateral = Troves[_borrower].coll.add(pendingCollateralReward);

        // Compute pending base debt
        uint pendingBaseLUSDDebtReward = rewards.getPendingBaseLUSDDebtReward(_borrower);
        uint pendingShieldedLUSDDebtReward = rewards.getPendingShieldedLUSDDebtReward(_borrower);

        // Apply pending debt rewards, convert where needed
        uint currentLUSDDebt = shielded[_borrower] ?
            Troves[_borrower].debt.add(pendingShieldedLUSDDebtReward).add(pendingBaseLUSDDebtReward * accumulatedRate / accumulatedShieldRate) :
            Troves[_borrower].debt.add(pendingBaseLUSDDebtReward).add(pendingShieldedLUSDDebtReward * accumulatedShieldRate / accumulatedRate);

        return (currentCollateral, currentLUSDDebt);
    }

    // Get the borrower's pending accumulated LUSD reward, earned by their stake
    // TODO improve
    function getPendingActualLUSDDebtReward(address _borrower) public view override returns (uint) {
        return _actualDebt(rewards.getPendingBaseLUSDDebtReward(_borrower), false).add(_actualDebt(rewards.getPendingShieldedLUSDDebtReward(_borrower), true));
    }

    // Return the Troves entire debt and coll, including pending rewards from redistributions.
    function getEntireDebtAndColl(
        address _borrower
    )
        public
        view
        override
        returns (uint debt, uint coll, uint pendingBaseLUSDDebtReward, uint pendingBaseCollateralReward,
                 uint pendingShieldedLUSDDebtReward, uint pendingShieldedCollateralReward)
    {
        debt = Troves[_borrower].debt;
        coll = Troves[_borrower].coll;

        (pendingBaseLUSDDebtReward,
         pendingBaseCollateralReward,
         pendingShieldedLUSDDebtReward,
         pendingShieldedCollateralReward) = rewards.getPendingRewards(_borrower);

        /*
        pendingBaseLUSDDebtReward = rewards.getPendingBaseLUSDDebtReward(_borrower);
        pendingBaseCollateralReward = rewards.getPendingBaseCollateralReward(_borrower);

        pendingShieldedLUSDDebtReward = rewards.getPendingShieldedLUSDDebtReward(_borrower);
        pendingShieldedCollateralReward = rewards.getPendingShieldedCollateralReward(_borrower);
        */

        bool isShielded = shielded[_borrower];

        // add debt, converting shield <-> base where needed
        if (isShielded) {
            debt = debt.add(pendingShieldedLUSDDebtReward);
            debt = debt.add(pendingBaseLUSDDebtReward * accumulatedRate / accumulatedShieldRate);
        } else {
            debt = debt.add(pendingBaseLUSDDebtReward);
            debt = debt.add(pendingShieldedLUSDDebtReward * accumulatedShieldRate / accumulatedRate);
        }

        coll = coll.add(pendingBaseCollateralReward);
        coll = coll.add(pendingShieldedCollateralReward);
    }

    function closeTrove(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        _closeTrove(_borrower, Status.closedByOwner);
    }
    function closeTroveLiquidation(address _borrower) external override {
        _requireCallerIsLiquidations();
        _closeTrove(_borrower, Status.closedByLiquidation);
    }

    function _closeTrove(address _borrower, Status closedStatus) internal {
        assert(closedStatus != Status.nonExistent && closedStatus != Status.active);

        bool isShielded = shielded[_borrower];

        _requireMoreThanOneTroveInSystem();

        Troves[_borrower].status = closedStatus;
        Troves[_borrower].coll = 0;
        Troves[_borrower].debt = 0;

        rewards.resetTroveRewardSnapshots(_borrower);

        _removeTroveOwner(_borrower, isShielded);

        if (isShielded) {
            shielded[_borrower] = false;
            sortedShieldedTroves.remove(_borrower);
        } else {
            sortedTroves.remove(_borrower);
        }
    }

    /*
    // Push the owner's address to the Trove owners list, and record the corresponding array index on the Trove struct
    function addTroveOwnerToArray(address _borrower, bool _shielded) external override returns (uint index) {
        _requireCallerIsBorrowerOperations();
        if (_shielded) {
            return _addShieldedTroveOwnerToArray(_borrower);
        } else {
            return _addTroveOwnerToArray(_borrower);
        }
    }
    */

    function _addTroveOwnerToArray(address _borrower) internal returns (uint128 index) {
        /* Max array size is 2**128 - 1, i.e. ~3e30 troves. No risk of overflow, since troves have minimum LUSD
        debt of liquidation reserve plus MIN_NET_DEBT. 3e30 LUSD dwarfs the value of all wealth in the world ( which is < 1e15 USD). */

        // Push the Troveowner to the array
        TroveOwners.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(TroveOwners.length.sub(1));
        Troves[_borrower].arrayIndex = index;

        return index;
    }

    function _addShieldedTroveOwnerToArray(address _borrower) internal returns (uint128 index) {
        /* Max array size is 2**128 - 1, i.e. ~3e30 troves. No risk of overflow, since troves have minimum LUSD
        debt of liquidation reserve plus MIN_NET_DEBT. 3e30 LUSD dwarfs the value of all wealth in the world ( which is < 1e15 USD). */

        // Push the Troveowner to the array
        ShieldedTroveOwners.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(ShieldedTroveOwners.length.sub(1));
        Troves[_borrower].arrayIndex = index;

        return index;
    }

    function shieldTrove(address _borrower, address _upperHint, address _lowerHint) external override {
        _requireCallerIsBorrowerOperations();

        require(Troves[_borrower].status == Status.active, "Trove is not active");
        require(!shielded[_borrower], "Trove is already shielded");

        uint256 currentNormDebt = Troves[_borrower].debt;

        if (currentNormDebt > 0) {
            // Remove from base pool
            activePool.decreaseLUSDDebt(currentNormDebt);

            // Convert normalized debt from base to shielded
            uint256 newNormDebt = currentNormDebt * accumulatedRate / accumulatedShieldRate;
            Troves[_borrower].debt = newNormDebt;
            // Add to shielded pool
            activeShieldedPool.increaseLUSDDebt(newNormDebt);
        }

        shielded[_borrower] = true;

        // add to shielded array
        _addShieldedTroveOwnerToArray(_borrower);

        // add to shielded list
        sortedShieldedTroves.insert(_borrower, getNominalICR(_borrower), _upperHint, _lowerHint);

        // remove from array
        _removeTroveOwner(_borrower, false);

        // remove from base list
        sortedTroves.remove(_borrower);
    }

    function unShieldTrove(address _borrower, address _upperHint, address _lowerHint) external override {
        _requireCallerIsBorrowerOperations();

        require(Troves[_borrower].status == Status.active, "Trove is not active");
        require(shielded[_borrower], "Trove is already unshielded");

        uint256 currentNormDebt = Troves[_borrower].debt;

        if (currentNormDebt > 0) {
            // Remove from base pool
            activePool.decreaseLUSDDebt(currentNormDebt);

            // Convert normalized debt from shielded to base
            uint256 newNormDebt = currentNormDebt * accumulatedShieldRate / accumulatedRate;
            Troves[_borrower].debt = newNormDebt;

            // Add to base pool
            activePool.increaseLUSDDebt(newNormDebt);
        }

        shielded[_borrower] = false;

        // add to base array
        _addTroveOwnerToArray(_borrower);

        // add to base list
        sortedTroves.insert(_borrower, getNominalICR(_borrower), _upperHint, _lowerHint);

        // remove from array
        _removeTroveOwner(_borrower, true);

        // remove from shielded list
        sortedShieldedTroves.remove(_borrower);
    }

    function createTrove(address _borrower, uint _nicr, address _upperHint, address _lowerHint, bool _redemptionShield) external override {
        _requireCallerIsBorrowerOperations();
        require(Troves[_borrower].status != Status.active, "Trove is not active");
        shielded[_borrower] = _redemptionShield;

        if (_redemptionShield) {
            _addShieldedTroveOwnerToArray(_borrower);
            sortedShieldedTroves.insert(_borrower, _nicr, _upperHint, _lowerHint);
        } else {
            _addTroveOwnerToArray(_borrower);
            sortedTroves.insert(_borrower, _nicr, _upperHint, _lowerHint);
        }

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
            emit ShieldedTroveIndexUpdated(addressToMove, index);
        } else {
            TroveOwners[index] = addressToMove;
            TroveOwners.pop();
            emit TroveIndexUpdated(addressToMove, index);
        }

    }

    function getTCR(uint _price) external view override returns (uint) {
        return _getTCR(_price, accumulatedRate, accumulatedShieldRate);
    }

    function checkRecoveryMode(uint _price) external view override returns (bool) {
        return _checkRecoveryMode(_price, accumulatedRate, accumulatedShieldRate);
    }

    function _calcRevenuePayments(uint256 payment) internal pure returns (uint256 stakePayment, uint256 spPayment) {
        stakePayment = stakeRevenueAllocation * payment / 1e18;
        spPayment = payment - stakePayment;
      
    }

    function dripIsStale() external view returns (bool) {
        return block.timestamp - lastAccRateUpdateTime > DRIP_STALENESS_THRESHOLD;
    }

    function drip() external override {
        uint interestRate = relayer.getRate();
        uint shieldedInterestRate = interestRate.sub(RATE_PRECISION).mul(kappa).div(DECIMAL_PRECISION).add(RATE_PRECISION);
        _drip(interestRate, shieldedInterestRate);
    }

    function _updateAccRates(uint256 newAccRate, uint256 newAccShieldRate) internal {
        accumulatedRate = newAccRate;
        accumulatedShieldRate = newAccShieldRate;
        lastAccRateUpdateTime = block.timestamp;
        emit AccInterestRateUpdated(newAccRate, newAccShieldRate);
    }

    function _drip(uint256 interestRate, uint256 shieldedInterestRate) internal {

        // can't distributetoSP() when empty
        if (stabilityPool.getTotalLUSDDeposits() == 0) return;

        // time since last update
        uint256 secondsPassed = block.timestamp - lastAccRateUpdateTime;
        if (secondsPassed == 0) {
            return;
        }

        uint256 existingAccRate = accumulatedRate;
        uint256 existingAccShieldRate = accumulatedShieldRate;

        //emit PreDrip(existingSystemDebt, lusdToken.totalSupply());

        uint256 newAccRate = _calcAccumulatedRate(existingAccRate, interestRate, secondsPassed);
        uint256 newAccShieldRate = _calcAccumulatedRate(existingAccShieldRate, shieldedInterestRate, secondsPassed);
        //uint256 rateDelta = newAccRate - accumulatedRate;

        _updateAccRates(newAccRate, newAccShieldRate);

        /*
        uint256 newBaseDebt = getEntireNormalizedBaseDebt().mul(newAccRate).div(RATE_PRECISION);
        uint256 newShieldedDebt = getEntireNormalizedShieldedDebt().mul(newAccShieldRate).div(RATE_PRECISION);
        uint256 totalNewDebt = newBaseDebt.add(newShieldedDebt);
        */
        uint256 totalNewDebt = getEntireSystemDebt(newAccRate, newAccShieldRate);
        uint256 currentSupply = lusdToken.totalSupply();

        uint256 newInterest = 0;

        if (totalNewDebt > currentSupply) {
            newInterest = totalNewDebt - currentSupply;
        }

        //emit Drip(newInterest, totalNewDebt, currentSupply);

        if (newInterest == 0) {
            emit Drip(0, 0);
            return;
        }
        (uint256 spPayment, uint256 stakePayment) = _calcRevenuePayments(newInterest);

        emit Drip(stakePayment, spPayment);

        // Mint and distribute to SP
        lusdToken.mint(address(stabilityPool), spPayment);
        stabilityPool.distributeToSP(spPayment);

        // Mint and distribute to staking
        if (stakePayment > 0) {
            lusdToken.mint(address(lqtyStaking), stakePayment);
            lqtyStaking.increaseF_LUSD(stakePayment);
        }

        //emit PostDrip(existingSystemDebt, existingSupply, existingAccRate, getEntireSystemDebt(newAccRate), lusdToken.totalSupply(), newAccRate, newInterest, rateDelta);

    }

    // External view wrapper
    function calcAccumulatedRate(uint256 accRate, uint256 interestRate, uint256 minutesPassed) external pure returns (uint256) {
        return _calcAccumulatedRate(accRate, interestRate, minutesPassed);
    }

    // Internal rate compounding function
    function _calcAccumulatedRate(uint256 accRate, uint256 interestRate, uint256 secondsPassed) internal pure returns (uint256) {
        return accRate * LiquityMath._rpower(interestRate, secondsPassed, RATE_PRECISION) / RATE_PRECISION;
    }

    /*
    function _getTCR(uint _price) internal view returns (uint TCR) {
        uint entireSystemColl = getEntireSystemColl();
        uint entireSystemDebt = getEntireSystemDebt(accumulatedRate, accumulatedShieldRate);
        uint par = relayer.par();

        TCR = LiquityMath._computeCR(entireSystemColl, entireSystemDebt, _price, par);

        return TCR;
    }
    */

    function _getTCR(uint _price) internal view returns (uint) {
        return _getTCR(_price, accumulatedRate, accumulatedShieldRate);
    }

    function _normalizedDebt(uint256 _debt, bool _shielded) internal view returns (uint256 normDebt) {
        normDebt = _shielded ? _debt.mul(RATE_PRECISION).div(accumulatedShieldRate) : _debt.mul(RATE_PRECISION).div(accumulatedRate);
        /*
        if (norm_debt.mul(accumulatedRate).div(RATE_PRECISION) < debt) {
            norm_debt += 1;
        }
        */
    }


    // Returns the actual debt from normalized debt
    function _actualDebt(uint256 _normDebt, bool _shielded) internal view returns (uint256 actualDebt) {
        actualDebt = _shielded ? _normDebt.mul(accumulatedShieldRate).div(RATE_PRECISION) :
            _normDebt.mul(accumulatedRate).div(RATE_PRECISION);

        // Round up if rounding caused an underestimation
        //if (actualDebt.mul(RATE_PRECISION).div(accumulatedRate) < normalizedDebt) {
        //    actualDebt += 1;
        //}

    }

    // --- 'require' wrapper functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(msg.sender == borrowerOperationsAddress, "TroveManager: Caller is not BO contract");
    }

    function _requireCallerIsBorrowerOperationsOrRewards() internal view {
        require(msg.sender == borrowerOperationsAddress || msg.sender == address(rewards),
        "TroveManager: Caller is not BO or Rewards contract");
    }

    function _requireCallerIsLiquidations() internal view {
        require(msg.sender == address(liquidations), "TroveManager: Caller is not Liquidations contract");
    }

    function _requireCallerIsRewards() internal view {
        require(msg.sender == address(rewards), "TroveManager: Caller is not Rewards contract");
    }

    function _requireLUSDBalanceCoversRedemption(ILUSDToken _lusdToken, address _redeemer, uint _amount) internal view {
        require(_lusdToken.balanceOf(_redeemer) >= _amount, "TroveManager: Requested redemption amount must be <= user's LUSD balance");
    }

    function _requireMoreThanOneTroveInSystem() internal view {
        // original check
        //require (TroveOwnersArrayLength > 1 && sortedTroves.getSize() > 1, "TroveManager: Only one trove in the system");
        uint total = sortedTroves.getSize() + sortedShieldedTroves.getSize();
        require(total > 1, "Only one trove in the system");
    }

    function _requireTCRoverMCR(uint _price) internal view {
        require(_getTCR(_price) >= MCR, "TroveManager: Cannot redeem when TCR < MCR");
    }

    function _requireAfterBootstrapPeriod() internal view {
        uint systemDeploymentTime = lqtyToken.getDeploymentStartTime();
        require(block.timestamp >= systemDeploymentTime.add(BOOTSTRAP_PERIOD), "TroveManager: Redemptions not allowed during bootstrap");
    }

    function _requireValidMaxFeePercentage(uint _maxFeePercentage) internal pure {
        require(_maxFeePercentage >= REDEMPTION_FEE_FLOOR && _maxFeePercentage <= DECIMAL_PRECISION,
            "Max fee percentage must be between 0.5% and 100%");
    }

    // --- Trove property getters ---

    function getTroveStatus(address _borrower) external view override returns (uint) {
        return uint(Troves[_borrower].status);
    }

    function getTroveStake(address _borrower) external view override returns (uint) {
        return Troves[_borrower].stake;
    }

    function getTroveDebt(address _borrower) external view override returns (uint) {
        return Troves[_borrower].debt;
    }

    function getTroveActualDebt(address _borrower) external view override returns (uint) {
        return _actualDebt(Troves[_borrower].debt, shielded[_borrower]);
    }

    function getTroveColl(address _borrower) external view override returns (uint) {
        return Troves[_borrower].coll;
    }

    function getTroveDebtAndColl(address _borrower) external view override returns (uint, uint) {
        return (Troves[_borrower].debt, Troves[_borrower].coll);
    }

    // --- Trove property setters, called by BorrowerOperations ---

    function setTroveStatus(address _borrower, uint _num) external override {
        _requireCallerIsBorrowerOperations();
        Troves[_borrower].status = Status(_num);
    }

    function setTroveStake(address _borrower, uint _num) external override {
        _requireCallerIsRewards();
        Troves[_borrower].stake = _num;
    }

    function increaseTroveColl(address _borrower, uint _collIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperationsOrRewards();
        uint newColl = Troves[_borrower].coll.add(_collIncrease);
        Troves[_borrower].coll = newColl;
        return newColl;
    }

    function decreaseTroveColl(address _borrower, uint _collDecrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        uint newColl = Troves[_borrower].coll.sub(_collDecrease);
        Troves[_borrower].coll = newColl;
        return newColl;
    }

    function increaseTroveDebt(address _borrower, uint _debtIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperationsOrRewards();
        uint newDebt = Troves[_borrower].debt.add(_debtIncrease);
        Troves[_borrower].debt = newDebt;
        return newDebt;
    }

    function decreaseTroveDebt(address _borrower, uint _debtDecrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        uint newDebt = Troves[_borrower].debt.sub(_debtDecrease);
        Troves[_borrower].debt = newDebt;
        return newDebt;
    }
}
