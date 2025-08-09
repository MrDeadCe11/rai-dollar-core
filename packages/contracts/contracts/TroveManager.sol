// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
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

contract TroveManager is LiquityBase, Ownable, CheckContract, ITroveManager {
    string constant public NAME = "TroveManager";

    // --- Connected contract declarations ---

    IAggregator public aggregator;

    ILiquidations public liquidations;

    address public borrowerOperationsAddress;

    IStabilityPool public override stabilityPool;

    address gasPoolAddress;

    ICollSurplusPool public override collSurplusPool;

    ILUSDToken public override lusdToken;

    ILQTYToken public override lqtyToken;

    ILQTYStaking public override lqtyStaking;

    // A doubly linked list of Troves, sorted by their sorted by their collateral ratios
    ISortedTroves public sortedTroves;

    uint constant public REDEMPTION_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%

    uint internal constant DRIP_STALENESS_THRESHOLD = 1 hours;

    // During bootsrap period redemptions are not allowed
    uint internal constant BOOTSTRAP_PERIOD = 14 days;

    uint public override accumulatedRate = RATE_PRECISION; // accumulated interest rate
    uint public lastAccRateUpdateTime = block.timestamp;
    uint public stakeRevenueAllocation = 25*10**16; // 25%

    // max percent of debt value taken in collateral from a liquidated trove when offsetting from SP
    uint public LIQUIDATION_PENALTY = 105 * 10**16; //5%

    // max percent of debt value taken in collateral from a liquidated trove when redistributing debt
    uint public LIQUIDATION_PENALTY_REDIST = 110 * 10**16;

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
        uint256 partialNICR;
    }

    mapping (address => Trove) public Troves;

    uint public totalStakes;

    // Snapshot of the value of totalStakes, taken immediately after the latest liquidation
    uint public totalStakesSnapshot;

    // Snapshot of the total collateral across the ActivePool and DefaultPool, immediately after the latest liquidation.
    uint public totalCollateralSnapshot;


    /*
    * L_COLL and L_LUSDDebt track the sums of accumulated liquidation rewards per unit staked. During its lifetime, each stake earns:
    *
    * An collateral gain of ( stake * [L_COLL - L_COLL(0)] )
    * A LUSDDebt increase  of ( stake * [L_LUSDDebt - L_LUSDDebt(0)] )
    *
    * Where L_COLL(0) and L_LUSDDebt(0) are snapshots of L_COLL and L_LUSDDebt for the active Trove taken at the instant the stake was made
    */
    uint public L_COLL;
    uint public L_LUSDDebt;

    // Map addresses with active troves to their RewardSnapshot
    mapping (address => RewardSnapshot) public rewardSnapshots;

    // Object containing the collateral and LUSD snapshots for a given active trove
    struct RewardSnapshot { uint collateral; uint LUSDDebt;}

    // Array of all active trove addresses - used to to compute an approximate hint off-chain, for the sorted list insertion
    address[] public TroveOwners;

    // Error trackers for the trove redistribution calculation
    uint public lastCollateralError_Redistribution;
    uint public lastLUSDDebtError_Redistribution;

    struct ContractsCache {
        IActivePool activePool;
        IDefaultPool defaultPool;
        ILUSDToken lusdToken;
        ILQTYStaking lqtyStaking;
        ISortedTroves sortedTroves;
        ICollSurplusPool collSurplusPool;
        address gasPoolAddress;
    }
    // --- Variable container structs for redemptions ---

    struct RedemptionTotals {
        uint remainingLUSD;
        uint totalLUSDToRedeem;
        uint totalCollateralDrawn;
        uint collateralFee;
        uint collateralToSendToRedeemer;
        uint decayedBaseRate;
        uint price;
        uint par;
        uint totalLUSDSupplyAtStart;
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
        address _aggregatorAddress,
        address _liquidationsAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _gasPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _lusdTokenAddress,
        address _sortedTrovesAddress,
        address _lqtyTokenAddress,
        address _lqtyStakingAddress,
        address _relayerAddress,
        address _collateralTokenAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_aggregatorAddress);
        checkContract(_liquidationsAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_activePoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_gasPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_priceFeedAddress);
        checkContract(_lusdTokenAddress);
        checkContract(_sortedTrovesAddress);
        checkContract(_lqtyTokenAddress);
        checkContract(_lqtyStakingAddress);
        checkContract(_relayerAddress);
        checkContract(_collateralTokenAddress);
        aggregator = IAggregator(_aggregatorAddress);
        liquidations = ILiquidations(_liquidationsAddress);
        borrowerOperationsAddress = _borrowerOperationsAddress;
        activePool = IActivePool(_activePoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        stabilityPool = IStabilityPool(_stabilityPoolAddress);
        gasPoolAddress = _gasPoolAddress;
        collSurplusPool = ICollSurplusPool(_collSurplusPoolAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        lusdToken = ILUSDToken(_lusdTokenAddress);
        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        lqtyToken = ILQTYToken(_lqtyTokenAddress);
        lqtyStaking = ILQTYStaking(_lqtyStakingAddress);
        relayer = IRelayer(_relayerAddress);
        IERC20 collateralToken = IERC20(_collateralTokenAddress);

        assert(address(collateralToken) != address(0));
        
        collateralToken.approve(address(activePool), type(uint256).max);

        //emit AggregatorAddressChanged(_aggregatorAddress);
        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit GasPoolAddressChanged(_gasPoolAddress);
        emit CollSurplusPoolAddressChanged(_collSurplusPoolAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit LUSDTokenAddressChanged(_lusdTokenAddress);
        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit LQTYTokenAddressChanged(_lqtyTokenAddress);
        emit LQTYStakingAddressChanged(_lqtyStakingAddress);
        emit RelayerAddressChanged(_relayerAddress);

        _renounceOwnership();
    }

    // --- Getters ---

    function getTroveOwnersCount() external view override returns (uint) {
        return TroveOwners.length;
    }

    function getTroveFromTroveOwnersArray(uint _index) external view override returns (address) {
        return TroveOwners[_index];
    }

    // Move a Trove's pending debt and collateral rewards from distributions, from the Default Pool to the Active Pool
    function movePendingTroveRewardsToActivePool(IActivePool _activePool, IDefaultPool _defaultPool, uint _LUSD, uint _ETH) external override {
        _requireCallerIsLiquidations();
        _movePendingTroveRewardsToActivePool(_activePool, _defaultPool, _LUSD, _ETH);
    }

    // Move a Trove's pending debt and collateral rewards from distributions, from the Default Pool to the Active Pool
    function _movePendingTroveRewardsToActivePool(IActivePool _activePool, IDefaultPool _defaultPool, uint _LUSD, uint _collateral) internal {
        _defaultPool.decreaseLUSDDebt(_LUSD);
        _activePool.increaseLUSDDebt(_LUSD);
        _defaultPool.sendCollateralToActivePool(_collateral);
    }

    // --- Redemption functions ---

    // Redeem as much collateral as possible from _borrower's Trove in exchange for LUSD up to _maxLUSDamount
    function _redeemCollateralFromTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint _maxLUSDamount,
        uint _price,
        uint _par,
        RedemptionHints memory hints
    )
        internal returns (SingleRedemptionValues memory singleRedemption)
    {

        // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the Trove minus the liquidation reserve
        singleRedemption.LUSDLot = LiquityMath._min(_maxLUSDamount, _actualDebt(Troves[_borrower].debt).sub(LUSD_GAS_COMPENSATION));

        // Get the collateralLot of equivalent value in USD
        singleRedemption.collateralLot = singleRedemption.LUSDLot.mul(_par).div(_price);

        uint normDebt = _normalizedDebt(singleRedemption.LUSDLot);
        if (normDebt.mul(accumulatedRate).div(RATE_PRECISION) < _actualDebt(singleRedemption.LUSDLot)) {
            normDebt += 1;
        }

        // Decrease the debt and collateral of the current Trove according to the LUSD lot and corresponding collateral to send
        uint newDebt = (Troves[_borrower].debt).sub(normDebt);
        uint newColl = (Troves[_borrower].coll).sub(singleRedemption.collateralLot);

        // Change from eq to lte
        // since sub of normalized debt above could make 1 wei less
        // and actualDebt can also round down
        //if (_actualDebt(newDebt).sub(1) <= LUSD_GAS_COMPENSATION) {
        if (_actualDebt(newDebt) <= LUSD_GAS_COMPENSATION) {
            // No debt left in the Trove (except for the liquidation reserve), therefore the trove gets closed
            _removeStake(_borrower);
            _closeTrove(_borrower, Status.closedByRedemption);
            _redeemCloseTrove(_contractsCache, _borrower, LUSD_GAS_COMPENSATION, newColl);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.redeemCollateral);

        } else {
            uint newNICR = LiquityMath._computeNominalCR(newColl, newDebt);
            /*
            * If the provided hint is out of date, we bail since trying to reinsert without a good hint will almost
            * certainly result in running out of gas. 
            *
            * If the resultant net debt of the partial is less than the minimum, net debt we bail.
            */
            if (newNICR != hints.partialNICR || _getNetDebt(_actualDebt(newDebt)) < MIN_NET_DEBT) {
                //emit PartialNicr(_borrower, newNICR, _actualDebt(newDebt));
                singleRedemption.cancelledPartial = true;
                return singleRedemption;
            }

            _contractsCache.sortedTroves.reInsert(_borrower, newNICR, hints.upperHint, hints.lowerHint);

            Troves[_borrower].debt = newDebt;
            Troves[_borrower].coll = newColl;
            _updateStakeAndTotalStakes(_borrower);

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
    function _redeemCloseTrove(ContractsCache memory _contractsCache, address _borrower, uint _LUSD, uint _collateral) internal {
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

        _contractsCache.activePool.decreaseLUSDDebt(_normalizedDebt(_LUSD)+1);

        // send collateral from Active Pool to CollSurplus Pool
        _contractsCache.collSurplusPool.accountSurplus(_borrower, _collateral);
        _contractsCache.activePool.sendCollateral(address(_contractsCache.collSurplusPool), _collateral);
    }

    function _isValidFirstRedemptionHint(ISortedTroves _sortedTroves, address _firstRedemptionHint, uint _price) internal view returns (bool) {
        if (_firstRedemptionHint == address(0) ||
            !_sortedTroves.contains(_firstRedemptionHint) ||
            getCurrentICR(_firstRedemptionHint, _price) < MCR
        ) {
            return false;
        }

        address nextTrove = _sortedTroves.getNext(_firstRedemptionHint);
        return nextTrove == address(0) || getCurrentICR(nextTrove, _price) < MCR;
    }

    /* Send _LUSDamount LUSD to the system and redeem the corresponding amount of collateral from as many Troves as are needed to fill the redemption
    * request.  Applies pending rewards to a Trove before reducing its debt and coll.
    *
    * Note that if _amount is very large, this function can run out of gas, specially if traversed troves are small. This can be easily avoided by
    * splitting the total _amount in appropriate chunks and calling the function multiple times.
    *
    * Param `_maxIterations` can also be provided, so the loop through Troves is capped (if it’s zero, it will be ignored).This makes it easier to
    * avoid OOG for the frontend, as only knowing approximately the average cost of an iteration is enough, without needing to know the “topology”
    * of the trove list. It also avoids the need to set the cap in stone in the contract, nor doing gas calculations, as both gas price and opcode
    * costs can vary.
    *
    * All Troves that are redeemed from -- with the likely exception of the last one -- will end up with no debt left, therefore they will be closed.
    * If the last Trove does have some remaining debt, it has a finite ICR, and the reinsertion could be anywhere in the list, therefore it requires a hint.
    * A frontend should use getRedemptionHints() to calculate what the ICR of this Trove will be after redemption, and pass a hint for its position
    * in the sortedTroves list along with the ICR value that the hint was found for.
    *
    * If another transaction modifies the list between calling getRedemptionHints() and passing the hints to redeemCollateral(), it
    * is very likely that the last (partially) redeemed Trove would end up with a different ICR than what the hint is for. In this case the
    * redemption will stop after the last completely redeemed Trove and the sender will keep the remaining LUSD amount, which they can attempt
    * to redeem later.
    */
    function redeemCollateral(
        uint _LUSDamount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint _partialRedemptionHintNICR,
        uint _maxIterations,
        uint _maxFeePercentage
    )
        external
        override
    {
        ContractsCache memory contractsCache = ContractsCache(
            activePool,
            defaultPool,
            lusdToken,
            lqtyStaking,
            sortedTroves,
            collSurplusPool,
            gasPoolAddress
        );
        RedemptionTotals memory totals;
        RedemptionHints memory hints;

        _requireValidMaxFeePercentage(_maxFeePercentage);
        _requireAfterBootstrapPeriod();
        totals.price = priceFeed.fetchPrice();
        uint interestRate;
        (interestRate, totals.par) = relayer.updateRateAndPar();
        // disabling drip as it's causing a mismatch w/ newNICR and hints
        //_drip(interestRate);
        _requireTCRoverMCR(totals.price);
        _requireAmountGreaterThanZero(_LUSDamount);
        _requireLUSDBalanceCoversRedemption(contractsCache.lusdToken, msg.sender, _LUSDamount);

        totals.totalLUSDSupplyAtStart = getEntireSystemDebt(accumulatedRate);
        // Confirm redeemer's balance is less than total LUSD supply
        assert(contractsCache.lusdToken.balanceOf(msg.sender) <= totals.totalLUSDSupplyAtStart);

        totals.remainingLUSD = _LUSDamount;
        address currentBorrower;

        if (_isValidFirstRedemptionHint(contractsCache.sortedTroves, _firstRedemptionHint, totals.price)) {
            currentBorrower = _firstRedemptionHint;
        } else {
            currentBorrower = contractsCache.sortedTroves.getLast();
            // Find the first trove with ICR >= MCR
            while (currentBorrower != address(0) && getCurrentICR(currentBorrower, totals.price) < MCR) {
                currentBorrower = contractsCache.sortedTroves.getPrev(currentBorrower);
            }
        }

        // Loop through the Troves starting from the one with lowest collateral ratio until _amount of LUSD is exchanged for collateral
        if (_maxIterations == 0) { _maxIterations = uint(-1); }
        while (currentBorrower != address(0) && totals.remainingLUSD > 0 && _maxIterations > 0) {
            _maxIterations--;
            // Save the address of the Trove preceding the current one, before potentially modifying the list
            address nextUserToCheck = contractsCache.sortedTroves.getPrev(currentBorrower);

            _applyPendingRewards(contractsCache.activePool, contractsCache.defaultPool, currentBorrower);


            hints = RedemptionHints(_upperPartialRedemptionHint,
                                    _lowerPartialRedemptionHint,
                                    _partialRedemptionHintNICR);

            SingleRedemptionValues memory singleRedemption = _redeemCollateralFromTrove(
                contractsCache,
                currentBorrower,
                totals.remainingLUSD,
                totals.price,
                totals.par,
                hints
            );

            if (singleRedemption.cancelledPartial) break; // Partial redemption was cancelled (out-of-date hint, or new net debt < minimum), therefore we could not redeem from the last Trove

            totals.totalLUSDToRedeem  = totals.totalLUSDToRedeem.add(singleRedemption.LUSDLot);
            totals.totalCollateralDrawn = totals.totalCollateralDrawn.add(singleRedemption.collateralLot);

            totals.remainingLUSD = totals.remainingLUSD.sub(singleRedemption.LUSDLot);
            currentBorrower = nextUserToCheck;
        }
        //return;
        require(totals.totalCollateralDrawn > 0, "TroveManager: Unable to redeem any amount");

        // Decay the baseRate due to time passed, and then increase it according to the size of this redemption.
        // Use the saved total LUSD supply value, from before it was reduced by the redemption.
        aggregator.updateBaseRateFromRedemption(totals.totalCollateralDrawn, totals.price, totals.par, totals.totalLUSDSupplyAtStart);

        // Calculate the Collateral fee
        totals.collateralFee = aggregator.getRedemptionFee(totals.totalCollateralDrawn);

        _requireUserAcceptsFee(totals.collateralFee, totals.totalCollateralDrawn, _maxFeePercentage);

        // Send the collateral fee to the LQTY staking contract
        contractsCache.activePool.sendCollateral(address(contractsCache.lqtyStaking), totals.collateralFee);
        contractsCache.lqtyStaking.increaseF_Collateral(totals.collateralFee);

        totals.collateralToSendToRedeemer = totals.totalCollateralDrawn.sub(totals.collateralFee);

        emit Redemption(_LUSDamount, totals.totalLUSDToRedeem, totals.totalCollateralDrawn, totals.collateralFee);

        // Burn the total LUSD that is cancelled with debt, and send the redeemed collateral to msg.sender
        contractsCache.lusdToken.burn(msg.sender, totals.totalLUSDToRedeem);
        // Update Active Pool LUSD, and send collateral to account
        contractsCache.activePool.decreaseLUSDDebt(_normalizedDebt(totals.totalLUSDToRedeem));
        contractsCache.activePool.sendCollateral(msg.sender, totals.collateralToSendToRedeemer);
    }

    // --- Helper functions ---

    // Return the nominal collateral ratio (ICR) of a given Trove, without the price. Takes a trove's pending coll and debt rewards from redistributions into account.
    function getNominalICR(address _borrower) public view override returns (uint) {
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_borrower);

        uint NICR = LiquityMath._computeNominalCR(currentCollateral, currentLUSDDebt);
        return NICR;
    }

    // Return the current collateral ratio (ICR) of a given Trove. Takes a trove's pending coll and debt rewards from redistributions into account.
    function getCurrentICR(address _borrower, uint _price) public view override returns (uint) {
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_borrower);
        uint par = relayer.par();
        uint ICR = LiquityMath._computeCR(currentCollateral, _actualDebt(currentLUSDDebt), _price, par);
        return ICR;
    }

    function _getCurrentTroveAmounts(address _borrower) internal view returns (uint, uint) {
        uint pendingCollateralReward = getPendingCollateralReward(_borrower);
        uint pendingLUSDDebtReward = getPendingLUSDDebtReward(_borrower);

        uint currentCollateral = Troves[_borrower].coll.add(pendingCollateralReward);
        uint currentLUSDDebt = Troves[_borrower].debt.add(pendingLUSDDebtReward);

        return (currentCollateral, currentLUSDDebt);
    }

    function applyPendingRewards(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        return _applyPendingRewards(activePool, defaultPool, _borrower);
    }

    // Add the borrowers's coll and debt rewards earned from redistributions, to their Trove
    function _applyPendingRewards(IActivePool _activePool, IDefaultPool _defaultPool, address _borrower) internal {
        if (hasPendingRewards(_borrower)) {
            _requireTroveIsActive(_borrower);

            // Compute pending rewards
            uint pendingCollateralReward = getPendingCollateralReward(_borrower);
            uint pendingLUSDDebtReward = getPendingLUSDDebtReward(_borrower);

            // Apply pending rewards to trove's state
            Troves[_borrower].coll = Troves[_borrower].coll.add(pendingCollateralReward);
            Troves[_borrower].debt = Troves[_borrower].debt.add(pendingLUSDDebtReward);

            _updateTroveRewardSnapshots(_borrower);

            // Transfer from DefaultPool to ActivePool
            _movePendingTroveRewardsToActivePool(_activePool, _defaultPool, pendingLUSDDebtReward, pendingCollateralReward);

            emit TroveUpdated(
                _borrower,
                Troves[_borrower].debt,
                Troves[_borrower].coll,
                Troves[_borrower].stake,
                TroveManagerOperation.applyPendingRewards
            );
        }
    }

    // Update borrower's snapshots of L_COLL and L_LUSDDebt to reflect the current values
    function updateTroveRewardSnapshots(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
       return _updateTroveRewardSnapshots(_borrower);
    }

    function _updateTroveRewardSnapshots(address _borrower) internal {
        rewardSnapshots[_borrower].collateral = L_COLL;
        rewardSnapshots[_borrower].LUSDDebt = L_LUSDDebt;
        emit TroveSnapshotsUpdated(L_COLL, L_LUSDDebt);
    }

    // Get the borrower's pending accumulated Collateral reward, earned by their stake
    function getPendingCollateralReward(address _borrower) public view override returns (uint) {
        uint snapshotCollateral = rewardSnapshots[_borrower].collateral;
        uint rewardPerUnitStaked = L_COLL.sub(snapshotCollateral);

        if ( rewardPerUnitStaked == 0 || Troves[_borrower].status != Status.active) { return 0; }

        uint stake = Troves[_borrower].stake;

        uint pendingCollateralReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingCollateralReward;
    }
    
    // Get the borrower's pending accumulated LUSD reward, earned by their stake
    function getPendingLUSDDebtReward(address _borrower) public view override returns (uint) {
        uint snapshotLUSDDebt = rewardSnapshots[_borrower].LUSDDebt;
        uint rewardPerUnitStaked = L_LUSDDebt.sub(snapshotLUSDDebt);

        if ( rewardPerUnitStaked == 0 || Troves[_borrower].status != Status.active) { return 0; }

        uint stake =  Troves[_borrower].stake;

        uint pendingLUSDDebtReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingLUSDDebtReward;
    }

    // Get the borrower's pending accumulated LUSD reward, earned by their stake
    function getPendingActualLUSDDebtReward(address _borrower) public view override returns (uint) {
        return _actualDebt(getPendingLUSDDebtReward(_borrower));
    }

    function hasPendingRewards(address _borrower) public view override returns (bool) {
        /*
        * A Trove has pending rewards if its snapshot is less than the current rewards per-unit-staked sum:
        * this indicates that rewards have occured since the snapshot was made, and the user therefore has
        * pending rewards
        */
        if (Troves[_borrower].status != Status.active) {return false;}
       
        return (rewardSnapshots[_borrower].collateral < L_COLL);
    }

    // Return the Troves entire debt and coll, including pending rewards from redistributions.
    function getEntireDebtAndColl(
        address _borrower
    )
        public
        view
        override
        returns (uint debt, uint coll, uint pendingLUSDDebtReward, uint pendingCollateralReward)
    {
        debt = Troves[_borrower].debt;
        coll = Troves[_borrower].coll;

        pendingLUSDDebtReward = getPendingLUSDDebtReward(_borrower);
        pendingCollateralReward = getPendingCollateralReward(_borrower);

        debt = debt.add(pendingLUSDDebtReward);
        coll = coll.add(pendingCollateralReward);
    }

    function removeStake(address _borrower) external override {
        _requireCallerIsBOorLiq();
        return _removeStake(_borrower);
    }

    // Remove borrower's stake from the totalStakes sum, and set their stake to 0
    function _removeStake(address _borrower) internal {
        uint stake = Troves[_borrower].stake;
        totalStakes = totalStakes.sub(stake);
        Troves[_borrower].stake = 0;
    }

    function updateStakeAndTotalStakes(address _borrower) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        return _updateStakeAndTotalStakes(_borrower);
    }

    // Update borrower's stake based on their latest collateral value
    function _updateStakeAndTotalStakes(address _borrower) internal returns (uint) {
        uint newStake = _computeNewStake(Troves[_borrower].coll);
        uint oldStake = Troves[_borrower].stake;
        Troves[_borrower].stake = newStake;

        totalStakes = totalStakes.sub(oldStake).add(newStake);
        emit TotalStakesUpdated(totalStakes);

        return newStake;
    }

    // Calculate a new stake based on the snapshots of the totalStakes and totalCollateral taken at the last liquidation
    function _computeNewStake(uint _coll) internal view returns (uint) {
        uint stake;
        if (totalCollateralSnapshot == 0) {
            stake = _coll;
        } else {
            /*
            * The following assert() holds true because:
            * - The system always contains >= 1 trove
            * - When we close or liquidate a trove, we redistribute the pending rewards, so if all troves were closed/liquidated,
            * rewards would’ve been emptied and totalCollateralSnapshot would be zero too.
            */
            assert(totalStakesSnapshot > 0);
            stake = _coll.mul(totalStakesSnapshot).div(totalCollateralSnapshot);
        }
        return stake;
    }
    function redistributeDebtAndColl(uint _debt, uint _coll) external override {
        // requirecallerisliq
        _redistributeDebtAndColl(activePool, defaultPool, _debt, _coll);
    }
    // norm debt
    function _redistributeDebtAndColl(IActivePool _activePool, IDefaultPool _defaultPool, uint _debt, uint _coll) internal {
        if (_debt == 0) { return; }

        /*
        * Add distributed coll and debt rewards-per-unit-staked to the running totals. Division uses a "feedback"
        * error correction, to keep the cumulative error low in the running totals L_COLL and L_LUSDDebt:
        *
        * 1) Form numerators which compensate for the floor division errors that occurred the last time this
        * function was called.
        * 2) Calculate "per-unit-staked" ratios.
        * 3) Multiply each ratio back by its denominator, to reveal the current floor division error.
        * 4) Store these errors for use in the next correction when this function is called.
        * 5) Note: static analysis tools complain about this "division before multiplication", however, it is intended.
        */
        uint collateralNumerator = _coll.mul(DECIMAL_PRECISION).add(lastCollateralError_Redistribution);
        uint LUSDDebtNumerator = _debt.mul(DECIMAL_PRECISION).add(lastLUSDDebtError_Redistribution);

        // Get the per-unit-staked terms
        uint collateralRewardPerUnitStaked = collateralNumerator.div(totalStakes);
        uint LUSDDebtRewardPerUnitStaked = LUSDDebtNumerator.div(totalStakes);

        lastCollateralError_Redistribution = collateralNumerator.sub(collateralRewardPerUnitStaked.mul(totalStakes));
        lastLUSDDebtError_Redistribution = LUSDDebtNumerator.sub(LUSDDebtRewardPerUnitStaked.mul(totalStakes));

        // Add per-unit-staked terms to the running totals
        L_COLL = L_COLL.add(collateralRewardPerUnitStaked);
        L_LUSDDebt = L_LUSDDebt.add(LUSDDebtRewardPerUnitStaked);

        emit LTermsUpdated(L_COLL, L_LUSDDebt);

        // Transfer coll and debt from ActivePool to DefaultPool
        _activePool.decreaseLUSDDebt(_debt);
        _defaultPool.increaseLUSDDebt(_debt);
        _activePool.sendCollateral(address(_defaultPool), _coll);
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

        uint TroveOwnersArrayLength = TroveOwners.length;
        _requireMoreThanOneTroveInSystem(TroveOwnersArrayLength);

        Troves[_borrower].status = closedStatus;
        Troves[_borrower].coll = 0;
        Troves[_borrower].debt = 0;

        rewardSnapshots[_borrower].collateral = 0;
        rewardSnapshots[_borrower].LUSDDebt = 0;

        _removeTroveOwner(_borrower, TroveOwnersArrayLength);
        sortedTroves.remove(_borrower);
    }

    /*
    * Updates snapshots of system total stakes and total collateral, excluding a given collateral remainder from the calculation.
    * Used in a liquidation sequence.
    *
    * The calculation excludes a portion of collateral that is in the ActivePool:
    *
    * the total collateral gas compensation from the liquidation sequence
    *
    * The collateral as compensation must be excluded as it is always sent out at the very end of the liquidation sequence.
    */
    function updateSystemSnapshots_excludeCollRemainder(uint _collRemainder) external override {
        _requireCallerIsLiquidations();
        _updateSystemSnapshots_excludeCollRemainder(activePool, _collRemainder);
    }
    function _updateSystemSnapshots_excludeCollRemainder(IActivePool _activePool, uint _collRemainder) internal {
        totalStakesSnapshot = totalStakes;

        uint activeColl = _activePool.getCollateral();
        uint liquidatedColl = defaultPool.getCollateral();
        totalCollateralSnapshot = activeColl.sub(_collRemainder).add(liquidatedColl);

        emit SystemSnapshotsUpdated(totalStakesSnapshot, totalCollateralSnapshot);
    }

    // Push the owner's address to the Trove owners list, and record the corresponding array index on the Trove struct
    function addTroveOwnerToArray(address _borrower) external override returns (uint index) {
        _requireCallerIsBorrowerOperations();
        return _addTroveOwnerToArray(_borrower);
    }

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

    /*
    * Remove a Trove owner from the TroveOwners array, not preserving array order. Removing owner 'B' does the following:
    * [A B C D E] => [A E C D], and updates E's Trove struct to point to its new array index.
    */
    function _removeTroveOwner(address _borrower, uint TroveOwnersArrayLength) internal {
        Status troveStatus = Troves[_borrower].status;
        // It’s set in caller function `_closeTrove`
        assert(troveStatus != Status.nonExistent && troveStatus != Status.active);

        uint128 index = Troves[_borrower].arrayIndex;
        uint length = TroveOwnersArrayLength;
        uint idxLast = length.sub(1);

        assert(index <= idxLast);

        address addressToMove = TroveOwners[idxLast];

        TroveOwners[index] = addressToMove;
        Troves[addressToMove].arrayIndex = index;
        emit TroveIndexUpdated(addressToMove, index);

        TroveOwners.pop();
    }

    function getTCR(uint _price) external view override returns (uint) {
        return _getTCR(_price, accumulatedRate);
    }

    function checkRecoveryMode(uint _price) external view override returns (bool) {
        return _checkRecoveryMode(_price, accumulatedRate);
    }

    function _calcRevenuePayments(uint256 payment) internal view returns (uint256 stakePayment, uint256 spPayment) {
        stakePayment = stakeRevenueAllocation * payment / 1e18;
        spPayment = payment - stakePayment;
      
    }

    function dripIsStale() external returns (bool) {
        return block.timestamp - lastAccRateUpdateTime > DRIP_STALENESS_THRESHOLD;
    }

    function drip() external override {
        uint interestRate = relayer.getRate();
        _drip(interestRate);
    }

    function _updateAccRate(uint256 newAccRate) internal {
        accumulatedRate = newAccRate;
        lastAccRateUpdateTime = block.timestamp;
        emit AccInterestRateUpdated(newAccRate);
    }

    function _drip(uint256 interestRate) internal {

        // can't distributetoSP() when empty
        if (stabilityPool.getTotalLUSDDeposits() == 0) return;

        // time since last update
        uint256 secondsPassed = block.timestamp - lastAccRateUpdateTime;
        if (secondsPassed == 0) {
            return;
        }


        uint256 existingAccRate = accumulatedRate;

        //emit PreDrip(existingSystemDebt, lusdToken.totalSupply());

        uint256 newAccRate = _calcAccumulatedRate(existingAccRate, interestRate, secondsPassed);
        uint256 rateDelta = newAccRate - accumulatedRate;

        _updateAccRate(newAccRate);

        uint256 newDebt = getEntireNormalizedSystemDebt().mul(newAccRate).div(RATE_PRECISION);
        uint256 currentSupply = lusdToken.totalSupply();

        uint256 newInterest = 0;

        if (newDebt > currentSupply) {
            newInterest = newDebt - currentSupply;
        }

        //emit Drip(newInterest, newDebt, currentSupply);

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
    function calcAccumulatedRate(uint256 accRate, uint256 interestRate,uint256 minutesPassed) external view returns (uint256) {
        return _calcAccumulatedRate(accRate, interestRate, minutesPassed);
    }

    // Internal rate compounding function
    function _calcAccumulatedRate(uint256 accRate, uint256 interestRate, uint256 secondsPassed) internal view returns (uint256) {
        return accRate * LiquityMath._rpower(interestRate, secondsPassed, RATE_PRECISION) / RATE_PRECISION;
    }

    function _getTCR(uint _price) internal view returns (uint TCR) {
        uint entireSystemColl = getEntireSystemColl();
        uint entireSystemDebt = getEntireSystemDebt(accumulatedRate);
        uint par = relayer.par();

        TCR = LiquityMath._computeCR(entireSystemColl, entireSystemDebt, _price, par);

        return TCR;
    }

    /*

    // External setter with bounds
    function setInterestRate(uint256 rate) external {
        _setInterestRate(_clamp(rate, MIN_INTEREST_RATE, MAX_INTEREST_RATE));
    }

    // Internal setter that also drips before update
    function _setInterestRate(uint256 rate) internal {
        _drip(); // must be implemented elsewhere
        interestRate = rate;
        emit InterestRateUpdated(rate);
    }

    // Clamp helper (not built into Solidity)
    function _clamp(uint256 x, uint256 minVal, uint256 maxVal) internal pure returns (uint256) {
        if (x < minVal) return minVal;
        if (x > maxVal) return maxVal;
        return x;
    }

    */

    function _normalizedDebt(uint256 debt) internal view returns (uint256) {
        uint256 norm_debt = debt.mul(RATE_PRECISION).div(accumulatedRate);
        /*
        if (norm_debt.mul(accumulatedRate).div(RATE_PRECISION) < debt) {
            norm_debt += 1;
        }
        */
        return norm_debt;
    }


    // Returns the actual debt from normalized debt
    function _actualDebt(uint256 normalizedDebt) internal view returns (uint256 actualDebt) {
        actualDebt = normalizedDebt.mul(accumulatedRate).div(RATE_PRECISION);

        // Round up if rounding caused an underestimation
        //if (actualDebt.mul(RATE_PRECISION).div(accumulatedRate) < normalizedDebt) {
        //    actualDebt += 1;
        //}

    }

    // --- 'require' wrapper functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(msg.sender == borrowerOperationsAddress, "TroveManager: Caller is not BO contract");
    }

    function _requireCallerIsLiquidations() internal view {
        require(msg.sender == address(liquidations), "TroveManager: Caller is not Liquidations contract");
    }

    function _requireCallerIsBOorLiq() internal view {
        require(msg.sender == borrowerOperationsAddress ||
                msg.sender == address(liquidations),
        "TroveManager: Caller is not BO contract");
    }

    function _requireTroveIsActive(address _borrower) internal view {
        require(Troves[_borrower].status == Status.active, "TroveManager: Trove does not exist or is closed");
    }

    function _requireLUSDBalanceCoversRedemption(ILUSDToken _lusdToken, address _redeemer, uint _amount) internal view {
        require(_lusdToken.balanceOf(_redeemer) >= _amount, "TroveManager: Requested redemption amount must be <= user's LUSD balance");
    }

    function _requireMoreThanOneTroveInSystem(uint TroveOwnersArrayLength) internal view {
        require (TroveOwnersArrayLength > 1 && sortedTroves.getSize() > 1, "TroveManager: Only one trove in the system");
    }

    function _requireAmountGreaterThanZero(uint _amount) internal pure {
        require(_amount > 0, "TroveManager: Amount must be greater than zero");
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
        return _actualDebt(Troves[_borrower].debt);
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

    function increaseTroveColl(address _borrower, uint _collIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
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
        _requireCallerIsBorrowerOperations();
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
