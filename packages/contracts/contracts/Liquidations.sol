// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/ILiquidations.sol";
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

contract Liquidations is LiquityBase, Ownable, CheckContract, ILiquidations {
    //string constant public NAME = "TroveManager";

    // --- Connected contract declarations ---

    address public borrowerOperationsAddress;

    ITroveManager public troveManager;

    IStabilityPool public override stabilityPool;

    address gasPoolAddress;

    ICollSurplusPool collSurplusPool;

    ILUSDToken public override lusdToken;

    ILQTYToken public override lqtyToken;

    ILQTYStaking public override lqtyStaking;

    //IRelayer public override relayer;

    // A doubly linked list of Troves, sorted by their sorted by their collateral ratios
    ISortedTroves public sortedTroves;

    // max percent of debt value taken in collateral from a liquidated trove when offsetting from SP
    uint public LIQUIDATION_PENALTY = 105 * 10**16; //5%

    // max percent of debt value taken in collateral from a liquidated trove when redistributing debt
    uint public LIQUIDATION_PENALTY_REDIST = 110 * 10**16;

    /*
    * --- Variable container structs for liquidations ---
    *
    * These structs are used to hold, return and assign variables inside the liquidation functions,
    * in order to avoid the error: "CompilerError: Stack too deep".
    **/

    struct LocalVariables_OuterLiquidationFunction {
        uint price;
        uint LUSDInSPForOffsets;
        uint liquidatedDebt;
        uint liquidatedColl;
    }

    struct LocalVariables_InnerSingleLiquidateFunction {
        uint collToLiquidate;
        uint pendingDebtReward;
        uint pendingCollReward;
    }

    struct LocalVariables_LiquidationSequence {
        uint remainingLUSDInSPForOffsets;
        uint i;
        uint ICR;
        address user;
        bool backToNormalMode;
        uint entireSystemDebt;
        uint entireSystemColl;
    }

    struct LiquidationValues {
        uint entireTroveDebt;
        uint entireTroveColl;
        uint collGasCompensation;
        uint LUSDGasCompensation;
        uint debtToOffset;
        uint collToSendToSP;
        uint debtToRedistribute;
        uint collToRedistribute;
        uint collSurplus;
    }

    struct LiquidationTotals {
        uint totalCollInSequence;
        uint totalDebtInSequence;
        uint totalCollGasCompensation;
        uint totalLUSDGasCompensation;
        uint totalDebtToOffset;
        uint totalCollToSendToSP;
        uint totalDebtToRedistribute;
        uint totalCollToRedistribute;
        uint totalCollSurplus;
    }

    struct LiquidationOffsetInputs {
        uint entireTroveDebt;
        uint actualTroveDebt;
        uint coll;
        uint LUSDInSPForOffsets;
        uint price;
        uint par;
        uint accumulatedRate;
        uint liqPenalty;
        uint liqPenaltyRedist;
    }

    struct ContractsCache {
        IActivePool activePool;
        IDefaultPool defaultPool;
        ILUSDToken lusdToken;
        ILQTYStaking lqtyStaking;
        ISortedTroves sortedTroves;
        ICollSurplusPool collSurplusPool;
        address gasPoolAddress;
    }

    // --- Events ---
    //event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint _stake, TroveManagerOperation _operation);
    //event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, TroveManagerOperation _operation);
    event TroveLiqInfo(uint256 entireColl, uint256 normDebt, uint256 collToLiquidate, uint256 collToSp, uint256 collToRedistribute,
                       uint256 actualDebt, uint256 totalNormLUSD);

    // --- Dependency setter ---

    function setAddresses(
        address _troveManagerAddress,
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
        address _relayerAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_troveManagerAddress);
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

        troveManager = ITroveManager(_troveManagerAddress);
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

        emit TroveManagerAddressChanged(_troveManagerAddress);
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


    // --- Trove Liquidation functions ---
    function getTroveStatus(address _borrower) external view returns(uint) {
        return troveManager.getTroveStatus(_borrower);
    }


    // Single liquidation function. Closes the trove if its ICR is lower than the minimum collateral ratio.
    function liquidate(address _borrower) external override {
        require(troveManager.getTroveStatus(_borrower) == 1, "Trove does not exist or is closed");

        address[] memory borrowers = new address[](1);
        borrowers[0] = _borrower;

        batchLiquidate(borrowers);
    }

    // --- Inner single liquidation functions ---

    function _maxPenaltyColl
    (
        uint _actualDebtToOffset,
        uint _par,
        uint _liqPenalty,
        uint _price
    ) internal pure returns (uint) {
        return _actualDebtToOffset
               .mul(_par)
               .mul(_liqPenalty)
               .div(_price)
               .div(DECIMAL_PRECISION);
    }

    function getCappedOffsetAndRedistributionVals(LiquidationOffsetInputs memory i)
        internal
        pure
        returns (uint debtToOffset, uint collToSendToSP, uint debtToRedistribute, uint collToRedistribute, uint collSurplus)
    {
        if (i.LUSDInSPForOffsets > 0) {
            debtToOffset = LiquityMath._min(i.entireTroveDebt, i.LUSDInSPForOffsets);
            uint actualDebtToOffset = debtToOffset.mul(i.accumulatedRate) / RATE_PRECISION;
            collToSendToSP = i.coll.mul(debtToOffset) / i.entireTroveDebt;

            uint maxToSP = _maxPenaltyColl(actualDebtToOffset, i.par, i.liqPenalty, i.price);
            if (collToSendToSP > maxToSP) collToSendToSP = maxToSP;

            if (actualDebtToOffset < i.actualTroveDebt) {
                uint remDebt = i.actualTroveDebt - actualDebtToOffset;
                collToRedistribute = _maxPenaltyColl(remDebt, i.par, i.liqPenaltyRedist, i.price);
                uint remColl = i.coll - collToSendToSP;
                if (collToRedistribute > remColl) collToRedistribute = remColl;
                debtToRedistribute = i.entireTroveDebt - debtToOffset;
            }
        } else {
            debtToRedistribute = i.entireTroveDebt;
            collToRedistribute = _maxPenaltyColl(i.actualTroveDebt, i.par, i.liqPenaltyRedist, i.price);
            if (collToRedistribute > i.coll) collToRedistribute = i.coll;
        }

        collSurplus = i.coll - collToSendToSP - collToRedistribute;
    }

    function _liquidate(
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        address _borrower,
        uint _LUSDInSPForOffsets, //norm
        uint _price,
        uint _par,
        uint _accumulatedRate
    )
        internal
        returns (LiquidationValues memory singleLiquidation)
    {
        LocalVariables_InnerSingleLiquidateFunction memory vars;

        //if (TroveOwners.length <= 1) {return singleLiquidation;} // don't liquidate if last trove
        if (troveManager.getTroveOwnersCount() <= 1) {return singleLiquidation;} // don't liquidate if last trove
        
        (singleLiquidation.entireTroveDebt, //normalized
        singleLiquidation.entireTroveColl,
        vars.pendingDebtReward, //normalized
        vars.pendingCollReward) = troveManager.getEntireDebtAndColl(_borrower);

        uint actualTroveDebt = _actualDebt(singleLiquidation.entireTroveDebt, _accumulatedRate);

        troveManager.movePendingTroveRewardsToActivePool(_activePool, _defaultPool, vars.pendingDebtReward, vars.pendingCollReward);
        troveManager.removeStake(_borrower);

        singleLiquidation.collGasCompensation = _getCollGasCompensation(singleLiquidation.entireTroveColl);
        singleLiquidation.LUSDGasCompensation = LUSD_GAS_COMPENSATION;

        LiquidationOffsetInputs memory offsetInputs = LiquidationOffsetInputs(singleLiquidation.entireTroveDebt,
                                                                                      actualTroveDebt,
                                                                                      singleLiquidation.entireTroveColl-singleLiquidation.collGasCompensation,
                                                                                      _LUSDInSPForOffsets, 
                                                                                      _price,
                                                                                      _par,
                                                                                      _accumulatedRate,
                                                                                      LIQUIDATION_PENALTY,
                                                                                      LIQUIDATION_PENALTY_REDIST);


        (singleLiquidation.debtToOffset,
        singleLiquidation.collToSendToSP,
        singleLiquidation.debtToRedistribute,
        singleLiquidation.collToRedistribute,
        singleLiquidation.collSurplus) = getCappedOffsetAndRedistributionVals(offsetInputs);


        troveManager.closeTroveLiquidation(_borrower);

        if (singleLiquidation.collSurplus > 0) {
            collSurplusPool.accountSurplus(_borrower, singleLiquidation.collSurplus);
        }
        //emit TroveLiquidated(_borrower, actualTroveDebt, singleLiquidation.entireTroveColl, TroveManagerOperation.liquidate);
        //emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.liquidate);
        return singleLiquidation;
    }


    /*
    * Liquidate a sequence of troves. Closes a maximum number of n under-collateralized Troves,
    * starting from the one with the lowest collateral ratio in the system, and moving upwards
    */
    function liquidateTroves(uint _n) external override {
        ContractsCache memory contractsCache = ContractsCache(
            activePool,
            defaultPool,
            ILUSDToken(address(0)),
            ILQTYStaking(address(0)),
            sortedTroves,
            ICollSurplusPool(address(0)),
            address(0)
        );
        IStabilityPool stabilityPoolCached = stabilityPool;

        LocalVariables_OuterLiquidationFunction memory vars;

        LiquidationTotals memory totals;

        (, uint par) = relayer.getRateAndPar();
        // drip before getting accRate
        troveManager.drip();
        uint256 accumulatedRate = troveManager.accumulatedRate();

        vars.price = priceFeed.fetchPrice();
        vars.LUSDInSPForOffsets = _normalizedDebt(stabilityPoolCached.getMaxAmountToOffset(), accumulatedRate);

        // Perform the liquidation sequence - tally the values, and obtain their totals
        totals = _getTotalsFromLiquidate(contractsCache.activePool, contractsCache.defaultPool, vars.price, vars.LUSDInSPForOffsets, _n, par, accumulatedRate);

        require(totals.totalDebtInSequence > 0, "TroveManager: nothing to liquidate");
 
        // Move liquidated ETH and LUSD to the appropriate pools

        uint totalActualDebtToOffset = totals.totalDebtToOffset.mul(accumulatedRate).div(RATE_PRECISION);

        //emit Offset(totalActualDebtToOffset, totals.totalDebtToOffset, totals.totalDebtInSequence,
        //            stabilityPoolCached.getTotalLUSDDeposits());

        stabilityPoolCached.offset(totalActualDebtToOffset, totals.totalDebtToOffset, totals.totalCollToSendToSP);

        troveManager.redistributeDebtAndColl(totals.totalDebtToRedistribute, totals.totalCollToRedistribute);
        if (totals.totalCollSurplus > 0) {
            contractsCache.activePool.sendCollateral(address(collSurplusPool), totals.totalCollSurplus);
        }

        // Update system snapshots
        troveManager.updateSystemSnapshots_excludeCollRemainder(totals.totalCollGasCompensation);

        vars.liquidatedDebt = _actualDebt(totals.totalDebtInSequence, accumulatedRate);
        vars.liquidatedColl = totals.totalCollInSequence.sub(totals.totalCollGasCompensation).sub(totals.totalCollSurplus);
        //vars.liquidatedColl = 0;
        emit Liquidation(vars.liquidatedDebt, vars.liquidatedColl, totals.totalCollGasCompensation, totals.totalLUSDGasCompensation);

        // Send gas compensation to caller
        _sendGasCompensation(contractsCache.activePool, msg.sender, totals.totalLUSDGasCompensation, totals.totalCollGasCompensation);
    }

    function _getTotalsFromLiquidate
    (
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        uint _price,
        uint _LUSDInSPForOffsets,
        uint _n, 
        uint _par,
        uint _accumulatedRate
    )
        internal
        returns(LiquidationTotals memory totals)
    {
        LocalVariables_LiquidationSequence memory vars;
        LiquidationValues memory singleLiquidation;
        ISortedTroves sortedTrovesCached = sortedTroves;

        vars.remainingLUSDInSPForOffsets = _LUSDInSPForOffsets;

        for (vars.i = 0; vars.i < _n; vars.i++) {
            vars.user = sortedTrovesCached.getLast();
            vars.ICR = troveManager.getCurrentICR(vars.user, _price);

            if (vars.ICR < MCR) {
                singleLiquidation = _liquidate(_activePool, _defaultPool, vars.user, vars.remainingLUSDInSPForOffsets, _price, _par, _accumulatedRate);

                vars.remainingLUSDInSPForOffsets = vars.remainingLUSDInSPForOffsets.sub(singleLiquidation.debtToOffset);

                // Add liquidation values to their respective running totals
                totals = _addLiquidationValuesToTotals(totals, singleLiquidation);

            } else break;  // break if the loop reaches a Trove with ICR >= MCR
        }
    }

    /*
    * Attempt to liquidate a custom list of troves provided by the caller.
    */
    function batchLiquidate(address[] memory _troveArray) public override {
        require(_troveArray.length != 0, "TroveManager: address array must not be empty");

        IActivePool activePoolCached = activePool;
        IDefaultPool defaultPoolCached = defaultPool;
        IStabilityPool stabilityPoolCached = stabilityPool;

        LocalVariables_OuterLiquidationFunction memory vars;
        LiquidationTotals memory totals;

        (, uint par) = relayer.getRateAndPar();
        // drip before getting accRate
        troveManager.drip();
        uint256 accumulatedRate = troveManager.accumulatedRate();

        vars.price = priceFeed.fetchPrice();
        vars.LUSDInSPForOffsets = _normalizedDebt(stabilityPoolCached.getMaxAmountToOffset(), accumulatedRate);

        // all normalized
        totals = _getTotalsFromBatchLiquidate(activePoolCached, defaultPoolCached, vars.price, vars.LUSDInSPForOffsets, _troveArray, par, accumulatedRate);

        require(totals.totalDebtInSequence > 0, "TroveManager: nothing to liquidate");


        uint totalActualDebtToOffset = totals.totalDebtToOffset.mul(accumulatedRate).div(RATE_PRECISION);

        //emit Offset(totalActualDebtToOffset, totals.totalDebtToOffset, totals.totalDebtInSequence,
        //            stabilityPoolCached.getTotalLUSDDeposits());

        stabilityPoolCached.offset(totalActualDebtToOffset, totals.totalDebtToOffset, totals.totalCollToSendToSP);

        // redistribute uses norm debt
        troveManager.redistributeDebtAndColl(totals.totalDebtToRedistribute, totals.totalCollToRedistribute);

        if (totals.totalCollSurplus > 0) {
            activePoolCached.sendCollateral(address(collSurplusPool), totals.totalCollSurplus);
        }

        // Update system snapshots
        troveManager.updateSystemSnapshots_excludeCollRemainder(totals.totalCollGasCompensation);

        vars.liquidatedDebt = _actualDebt(totals.totalDebtInSequence, accumulatedRate);
        vars.liquidatedColl = totals.totalCollInSequence.sub(totals.totalCollGasCompensation).sub(totals.totalCollSurplus);
        //vars.liquidatedColl = 0;
        emit Liquidation(vars.liquidatedDebt, vars.liquidatedColl, totals.totalCollGasCompensation, totals.totalLUSDGasCompensation);

        // Send gas compensation to caller
        _sendGasCompensation(activePoolCached, msg.sender, totals.totalLUSDGasCompensation, totals.totalCollGasCompensation);
    }

    function _getTotalsFromBatchLiquidate
    (
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        uint _price,
        uint _LUSDInSPForOffsets,
        address[] memory _troveArray,
        uint _par,
        uint accumulatedRate
    )
        internal
        returns(LiquidationTotals memory totals)
    {
        LocalVariables_LiquidationSequence memory vars;
        LiquidationValues memory singleLiquidation;

        vars.remainingLUSDInSPForOffsets = _LUSDInSPForOffsets;

        for (vars.i = 0; vars.i < _troveArray.length; vars.i++) {
            vars.user = _troveArray[vars.i];
            vars.ICR = troveManager.getCurrentICR(vars.user, _price);

            if (vars.ICR < MCR) {
                singleLiquidation = _liquidate(_activePool, _defaultPool, vars.user, vars.remainingLUSDInSPForOffsets, _price, _par, accumulatedRate);

                vars.remainingLUSDInSPForOffsets = vars.remainingLUSDInSPForOffsets.sub(singleLiquidation.debtToOffset);

                // Add liquidation values to their respective running totals
                totals = _addLiquidationValuesToTotals(totals, singleLiquidation);
            }
        }
    }

    // --- Liquidation helper functions ---
    function _addLiquidationValuesToTotals(LiquidationTotals memory oldTotals, LiquidationValues memory singleLiquidation)
    internal view returns(LiquidationTotals memory newTotals) {

        // Tally all the values with their respective running totals
        newTotals.totalCollGasCompensation = oldTotals.totalCollGasCompensation.add(singleLiquidation.collGasCompensation);
        newTotals.totalLUSDGasCompensation = oldTotals.totalLUSDGasCompensation.add(singleLiquidation.LUSDGasCompensation);
        // norm
        newTotals.totalDebtInSequence = oldTotals.totalDebtInSequence.add(singleLiquidation.entireTroveDebt);
        newTotals.totalCollInSequence = oldTotals.totalCollInSequence.add(singleLiquidation.entireTroveColl);
        // norm
        newTotals.totalDebtToOffset = oldTotals.totalDebtToOffset.add(singleLiquidation.debtToOffset);
        newTotals.totalCollToSendToSP = oldTotals.totalCollToSendToSP.add(singleLiquidation.collToSendToSP);
        newTotals.totalDebtToRedistribute = oldTotals.totalDebtToRedistribute.add(singleLiquidation.debtToRedistribute);
        newTotals.totalCollToRedistribute = oldTotals.totalCollToRedistribute.add(singleLiquidation.collToRedistribute);
        newTotals.totalCollSurplus = oldTotals.totalCollSurplus.add(singleLiquidation.collSurplus);

        return newTotals;
    }

    function _sendGasCompensation(IActivePool _activePool, address _liquidator, uint _LUSD, uint _ETH) internal {
        if (_LUSD > 0) {
            lusdToken.returnFromPool(gasPoolAddress, _liquidator, _LUSD);
        }

        if (_ETH > 0) {
            _activePool.sendCollateral(_liquidator, _ETH);
        }
    }

    // Move a Trove's pending debt and collateral rewards from distributions, from the Default Pool to the Active Pool
    function _movePendingTroveRewardsToActivePool(IActivePool _activePool, IDefaultPool _defaultPool, uint _LUSD, uint _ETH) internal {
        _defaultPool.decreaseLUSDDebt(_LUSD);
        _activePool.increaseLUSDDebt(_LUSD);
        _defaultPool.sendCollateralToActivePool(_ETH);
    }

    // --- Helper functions ---

    /*

    function _normalizedDebt(uint256 debt, uint256 accumulatedRate) internal pure returns (uint256) {
        uint256 norm_debt = debt.mul(RATE_PRECISION).div(accumulatedRate);
        
        //if (norm_debt.mul(accumulatedRate).div(RATE_PRECISION) < debt) {
        //    norm_debt += 1;
        //}
        return norm_debt;
    }


    // Returns the actual debt from normalized debt
    function _actualDebt(uint256 normalizedDebt, uint256 accumulatedRate) internal pure returns (uint256 actualDebt) {
        actualDebt = normalizedDebt.mul(accumulatedRate).div(RATE_PRECISION);

        // Round up if rounding caused an underestimation
        //if (actualDebt.mul(RATE_PRECISION).div(accumulatedRate) < normalizedDebt) {
        //    actualDebt += 1;
        //}
    }
    */

    // --- 'require' wrapper functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(msg.sender == borrowerOperationsAddress, "TroveManager: Caller is not BO contract");
    }
}
