// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
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
 
contract Liquidations is LiquityBase, Ownable, CheckContract, ILiquidations {
    //string constant public NAME = "TroveManager";

    // --- Connected contract declarations ---

    address public borrowerOperationsAddress;

    ITroveManager public troveManager;

    IRewards public rewards;

    IStabilityPool public override stabilityPool;

    address gasPoolAddress;

    ICollSurplusPool collSurplusPool;

    ILUSDToken public override lusdToken;

    //IRelayer public override relayer;

    // A doubly linked list of Troves, sorted by their sorted by their collateral ratios
    ISortedTroves public sortedTroves;

    // A doubly linked list of Troves, sorted by their sorted by their collateral ratios
    ISortedTroves public sortedShieldedTroves;

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
        uint accumulatedRate;
        uint accumulatedShieldRate;
        uint LUSDInSPForOffsets;
        uint liquidatedDebt;
        uint liquidatedColl;
    }

    struct LocalVariables_InnerSingleLiquidateFunction {
        uint collToLiquidate;
        uint pendingDebtReward;
        uint pendingCollReward;
        uint pendingShieldedDebtReward;
        uint pendingShieldedCollReward;
    }

    struct LocalVariables_LiquidationSequence {
        uint remainingLUSDInSPForOffsets;
        uint i;
        uint ICR;
        address user;
        bool shielded;
        uint troveRate;
        uint availableLUSDNorm;
        bool backToNormalMode;
        uint entireSystemDebt;
        uint entireSystemColl;
        address baseNext;
        uint baseICR;
        address shieldedNext;
        uint shieldedICR;
    }

    struct LiquidateInputs {
        IActivePool currentActivePool;
        IDefaultPool defaultPool;
        address borrower;
        uint LUSDInSPForOffsets;
        uint price;
        uint par;
        uint troveRate;
    }

    struct LiquidationValues {
        uint entireTroveDebt;
        uint entireTroveBaseDebt;
        uint entireTroveShieldedDebt;
        uint entireTroveColl;
        uint collGasCompensation;
        uint baseCollGasCompensation;
        uint shieldedCollGasCompensation;
        uint LUSDGasCompensation;
        uint baseLUSDGasCompensation;
        uint shieldedLUSDGasCompensation;
        uint debtToOffset;
        uint baseDebtToOffset;
        uint shieldedDebtToOffset;
        uint actualDebtToOffset;
        uint collToSendToSP;
        uint baseCollToSendToSP;
        uint shieldedCollToSendToSP;
        uint debtToRedistribute;
        uint baseDebtToRedistribute;
        uint shieldedDebtToRedistribute;
        uint collToRedistribute;
        uint baseCollToRedistribute;
        uint shieldedCollToRedistribute;
        uint collSurplus;
        uint baseCollSurplus;
        uint shieldedCollSurplus;
    }

    struct LiquidationTotals {
        uint totalCollInSequence;
        uint totalCollSurplus;
        uint totalBaseDebtInSequence;
        uint totalShieldedDebtInSequence;
        uint totalCollGasCompensation;
        uint totalBaseCollGasCompensation;
        uint totalShieldedCollGasCompensation;
        uint totalLUSDGasCompensation;
        uint totalBaseLUSDGasCompensation;
        uint totalShieldedLUSDGasCompensation;
        uint totalBaseDebtToOffset;
        uint totalShieldedDebtToOffset;
        uint totalActualBaseDebtToOffset;
        uint totalActualShieldedDebtToOffset;
        uint totalBaseCollToSendToSP;
        uint totalShieldedCollToSendToSP;
        uint totalBaseDebtToRedistribute;
        uint totalShieldedDebtToRedistribute;
        uint totalBaseCollToRedistribute;
        uint totalShieldedCollToRedistribute;
        uint totalBaseCollSurplus;
        uint totalShieldedCollSurplus;
    }

    struct LiquidationOffsetInputs {
        uint entireTroveDebt;
        uint actualTroveDebt;
        uint coll;
        uint LUSDInSPForOffsets;
        uint price;
        uint par;
        uint troveRate;
        uint liqPenalty;
        uint liqPenaltyRedist;
    }

    struct ContractsCache {
        IActivePool activePool;
        IActivePool activeShieldedPool;
        IDefaultPool defaultPool;
        ILUSDToken lusdToken;
        ISortedTroves sortedTroves;
        ISortedTroves sortedShieldedTroves;
        ICollSurplusPool collSurplusPool;
        address gasPoolAddress;
    }

    // --- Events ---
    //event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint _stake, TroveManagerOperation _operation);
    //event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, TroveManagerOperation _operation);
    event TroveLiqInfo(uint256 entireColl, uint256 normDebt, uint256 collToLiquidate, uint256 collToSp, uint256 collToRedistribute,
                       uint256 actualDebt, uint256 totalNormLUSD);
    event Offset(uint actualBaseDebt, uint baseDebt, uint baseColl, uint actualShieldedDebt, uint shieldedDebt, uint shieldedColl);
    event Value(uint value);
    event ValueBool(bool value);
    event Redistribute(uint baseDebt, uint baseColl, uint sDebt, uint sColl);



    // --- Dependency setter ---

    function setAddresses(
        address _troveManagerAddress,
        address _rewardsAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _activeShieldedPoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _gasPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _lusdTokenAddress,
        address _sortedTrovesAddress,
        address _sortedShieldedTrovesAddress,
        address _relayerAddress
    )
        external
        override
        onlyOwner
    {
        checkContract(_troveManagerAddress);
        checkContract(_rewardsAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_activePoolAddress);
        checkContract(_activeShieldedPoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_gasPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_priceFeedAddress);
        checkContract(_lusdTokenAddress);
        checkContract(_sortedTrovesAddress);
        checkContract(_relayerAddress);

        troveManager = ITroveManager(_troveManagerAddress);
        rewards = IRewards(_rewardsAddress);
        borrowerOperationsAddress = _borrowerOperationsAddress;
        activePool = IActivePool(_activePoolAddress);
        activeShieldedPool = IActivePool(_activeShieldedPoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        stabilityPool = IStabilityPool(_stabilityPoolAddress);
        gasPoolAddress = _gasPoolAddress;
        collSurplusPool = ICollSurplusPool(_collSurplusPoolAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        lusdToken = ILUSDToken(_lusdTokenAddress);
        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        sortedShieldedTroves = ISortedTroves(_sortedShieldedTrovesAddress);
        relayer = IRelayer(_relayerAddress);

        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit RewardsAddressChanged(_rewardsAddress);
        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit ActiveShieldedPoolAddressChanged(_activeShieldedPoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit GasPoolAddressChanged(_gasPoolAddress);
        emit CollSurplusPoolAddressChanged(_collSurplusPoolAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit LUSDTokenAddressChanged(_lusdTokenAddress);
        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit SortedShieldedTrovesAddressChanged(_sortedTrovesAddress);
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
        internal pure
        returns (uint debtToOffset, uint collToSendToSP, uint debtToRedistribute, uint collToRedistribute, uint collSurplus)
    {
        if (i.LUSDInSPForOffsets > 0) {
            debtToOffset = LiquityMath._min(i.entireTroveDebt, i.LUSDInSPForOffsets);
            uint actualDebtToOffset = debtToOffset.mul(i.troveRate) / RATE_PRECISION;
            collToSendToSP = i.coll.mul(debtToOffset) / i.entireTroveDebt;

            uint maxToSP = _maxPenaltyColl(actualDebtToOffset, i.par, i.liqPenalty, i.price);
            //emit Value(collToSendToSP);
            //emit Value(actualDebtToOffset);
            //emit Value(debtToOffset);
            //emit Value(maxToSP);
            //emit Value(i.troveRate);
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

    function _liquidate(LiquidateInputs memory _i)
        internal
        returns (LiquidationValues memory singleLiquidation)
    {
        LocalVariables_InnerSingleLiquidateFunction memory vars;

        //if (TroveOwners.length <= 1) {return singleLiquidation;} // don't liquidate if last trove
        //if (troveManager.getTroveOwnersCount() <= 1) {return singleLiquidation;} // don't liquidate if last trove
        
        (singleLiquidation.entireTroveDebt, //normalized
        singleLiquidation.entireTroveColl,
        vars.pendingDebtReward, // actual
        vars.pendingCollReward) = troveManager.getEntireDebtAndColl(_i.borrower);

        uint actualTroveDebt = _actualDebt(singleLiquidation.entireTroveDebt, _i.troveRate);

        rewards.movePendingTroveRewardsToActivePool(_i.currentActivePool, _i.defaultPool,
                                                    _normalizedDebt(vars.pendingDebtReward, _i.troveRate),
                                                    vars.pendingDebtReward, vars.pendingCollReward);

        //emit Value(_i.currentActivePool.getCollateral());
        //emit Value(vars.pendingCollReward);

        rewards.removeStake(_i.borrower);

        singleLiquidation.collGasCompensation = _getCollGasCompensation(singleLiquidation.entireTroveColl);
        singleLiquidation.LUSDGasCompensation = LUSD_GAS_COMPENSATION;


        LiquidationOffsetInputs memory offsetInputs = LiquidationOffsetInputs(singleLiquidation.entireTroveDebt,
                                                                                      actualTroveDebt,
                                                                                      singleLiquidation.entireTroveColl-singleLiquidation.collGasCompensation,
                                                                                      _i.LUSDInSPForOffsets, 
                                                                                      _i.price,
                                                                                      _i.par,
                                                                                      _i.troveRate,
                                                                                      LIQUIDATION_PENALTY,
                                                                                      LIQUIDATION_PENALTY_REDIST);


        (singleLiquidation.debtToOffset,
        singleLiquidation.collToSendToSP,
        singleLiquidation.debtToRedistribute,
        singleLiquidation.collToRedistribute,
        singleLiquidation.collSurplus) = getCappedOffsetAndRedistributionVals(offsetInputs);

        //emit Value(singleLiquidation.collToRedistribute);
        //emit Value(singleLiquidation.entireTroveColl);

        singleLiquidation.actualDebtToOffset = _actualDebt(singleLiquidation.debtToOffset, _i.troveRate);

        uint collToLiquidate = singleLiquidation.entireTroveColl.sub(singleLiquidation.collGasCompensation);

        emit TroveLiqInfo(singleLiquidation.entireTroveColl, singleLiquidation.entireTroveDebt, collToLiquidate,
                          singleLiquidation.collToSendToSP, singleLiquidation.collToRedistribute,
                          actualTroveDebt, _i.LUSDInSPForOffsets);
                          //actualTroveDebt, _LUSDInSPForOffsets);

        troveManager.closeTroveLiquidation(_i.borrower);

        if (singleLiquidation.collSurplus > 0) {
            collSurplusPool.accountSurplus(_i.borrower, singleLiquidation.collSurplus);
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
            activeShieldedPool,
            defaultPool,
            ILUSDToken(address(0)),
            sortedTroves,
            sortedShieldedTroves,
            ICollSurplusPool(address(0)),
            address(0)
        );
        IStabilityPool stabilityPoolCached = stabilityPool;

        LocalVariables_OuterLiquidationFunction memory vars;

        LiquidationTotals memory totals;

        (, uint par) = relayer.getRateAndPar();
        // drip before getting accRate
        troveManager.drip();
        vars.accumulatedRate = troveManager.accumulatedRate();
        vars.accumulatedShieldRate = troveManager.accumulatedShieldRate();

        vars.price = priceFeed.fetchPrice();
        vars.LUSDInSPForOffsets = stabilityPoolCached.getMaxAmountToOffset();

        // Perform the liquidation sequence - tally the values, and obtain their totals
        totals = _getTotalsFromLiquidate(contractsCache.activePool, contractsCache.defaultPool, contractsCache.activeShieldedPool,
                                         vars.price, vars.LUSDInSPForOffsets, _n, par, vars.accumulatedRate, vars.accumulatedShieldRate);

        require(totals.totalBaseDebtInSequence > 0 || totals.totalShieldedDebtInSequence > 0, "Liquidations: nothing to liquidate");
 
        // Move liquidated ETH and LUSD to the appropriate pools

        uint totalActualBaseDebtToOffset = totals.totalBaseDebtToOffset.mul(vars.accumulatedRate).div(RATE_PRECISION);
        uint totalActualShieldedDebtToOffset = totals.totalShieldedDebtToOffset.mul(vars.accumulatedShieldRate).div(RATE_PRECISION);

        emit Offset(totalActualBaseDebtToOffset, totals.totalBaseDebtToOffset, totals.totalBaseCollToSendToSP,
                    totalActualShieldedDebtToOffset, totals.totalShieldedDebtToOffset, totals.totalShieldedCollToSendToSP);

        stabilityPoolCached.offset(totalActualBaseDebtToOffset, totals.totalBaseDebtToOffset, totals.totalBaseCollToSendToSP,
                                   totalActualShieldedDebtToOffset, totals.totalShieldedDebtToOffset, totals.totalShieldedCollToSendToSP);

        emit Redistribute(totals.totalBaseDebtToRedistribute, totals.totalBaseCollToRedistribute,
                                        totals.totalShieldedDebtToRedistribute, totals.totalShieldedCollToRedistribute);

        rewards.redistributeDebtAndColl(totals.totalBaseDebtToRedistribute, totals.totalBaseCollToRedistribute,
                                        totals.totalShieldedDebtToRedistribute, totals.totalShieldedCollToRedistribute,
                                       vars.accumulatedRate, vars.accumulatedShieldRate);
                                        
        if (totals.totalBaseCollSurplus > 0) {
            contractsCache.activePool.sendCollateral(address(collSurplusPool), totals.totalBaseCollSurplus);
        }
        if (totals.totalShieldedCollSurplus > 0) {
            contractsCache.activeShieldedPool.sendCollateral(address(collSurplusPool), totals.totalShieldedCollSurplus);
        }

        // Update system snapshots
        rewards.updateSystemSnapshots_excludeCollRemainder(contractsCache.activePool, contractsCache.activeShieldedPool,
                                                           contractsCache.defaultPool,
                                                           totals.totalBaseCollGasCompensation.add(totals.totalShieldedCollGasCompensation));


        vars.liquidatedDebt = _actualDebt(totals.totalBaseDebtInSequence, vars.accumulatedRate) + _actualDebt(totals.totalShieldedDebtInSequence, vars.accumulatedShieldRate);
        vars.liquidatedColl = totals.totalCollInSequence.sub(totals.totalCollGasCompensation).sub(totals.totalCollSurplus);
        emit Liquidation(vars.liquidatedDebt, vars.liquidatedColl, totals.totalCollGasCompensation, totals.totalLUSDGasCompensation);

        // Send gas compensation to caller
        _sendGasCompensation(contractsCache.activePool, msg.sender, totals.totalBaseLUSDGasCompensation, totals.totalBaseCollGasCompensation);
        _sendGasCompensation(contractsCache.activeShieldedPool, msg.sender, totals.totalShieldedLUSDGasCompensation, totals.totalShieldedCollGasCompensation);
    }

    function _convertShieldedToBaseDebt(uint _shieldedDebt, uint accumulatedShieldRate, uint accumulatedRate) internal pure returns (uint baseDebt) {
        baseDebt = _shieldedDebt * accumulatedShieldRate / accumulatedRate;
    }

    function _convertBaseToShieldedDebt(uint _baseDebt, uint accumulatedShieldRate, uint accumulatedRate) internal pure returns (uint shieldedDebt) {
        shieldedDebt = _baseDebt * accumulatedRate / accumulatedShieldRate;
    }
    /*
    function _convertActualToShieldedDebt(uint _actualDebt, uint accumulatedShieldRate) internal returns (uint shieldedDebt) {
        shieldedebt = _actualDebt / accumulatedShieldRate;
    }
    */

    function _getNextLiquidatableBaseTrove(ISortedTroves _sortedTroves, uint _price) internal view returns (address troveOwner, uint icr) {
        if (troveManager.getTroveOwnersCount() == 1) return (address(0), 0);

        address owner = _sortedTroves.getLast();
        icr = troveManager.getCurrentICR(owner, _price);

        if (icr < MCR) {
            return (owner, icr);
        } else {
            return (address(0), 0);
        }
    }

    function _getNextLiquidatableShieldedTrove(ISortedTroves _sortedShieldedTroves, uint _price) internal view returns (address troveOwner, uint icr) {
        if (troveManager.getShieldedTroveOwnersCount() == 1) return (address(0), 0);

        address owner = _sortedShieldedTroves.getLast();
        icr = troveManager.getCurrentICR(owner, _price);

        if (icr < MCR) {
            return (owner, icr);
        } else {
            return (address(0), 0);
        }
    }

    function _getTotalsFromLiquidate
    (
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        IActivePool _activeShieldedPool,
        uint _price,
        uint _LUSDInSPForOffsets,
        uint _n, 
        uint _par,
        uint _accumulatedRate,
        uint _accumulatedShieldRate
    )
        internal
        returns(LiquidationTotals memory totals)
    {
        LocalVariables_LiquidationSequence memory vars;
        LiquidationValues memory singleLiquidation;
        LiquidateInputs memory liquidateInputs; 

        liquidateInputs.price = _price;
        liquidateInputs.par = _par;

        ISortedTroves sortedTrovesCached = sortedTroves;
        ISortedTroves sortedShieldedTrovesCached = sortedShieldedTroves;

        vars.remainingLUSDInSPForOffsets = _LUSDInSPForOffsets;

        (vars.baseNext, vars.baseICR) = _getNextLiquidatableBaseTrove(sortedTrovesCached, _price);
        (vars.shieldedNext, vars.shieldedICR) = _getNextLiquidatableShieldedTrove(sortedShieldedTrovesCached, _price);

        while (vars.i < _n) {

            // nothing liquidatable -> stop
            if (vars.baseNext == address(0) && vars.shieldedNext == address(0)) break;

            // only shielded is liquidatable
            if (vars.baseNext == address(0)) {
                vars.user = vars.shieldedNext;
                vars.troveRate = _accumulatedShieldRate;
                vars.shielded = true;
            // only base is liquidatable
            } else if (vars.shieldedNext == address(0)) {
                vars.user = vars.baseNext;
                vars.troveRate = _accumulatedRate;
                vars.shielded = false;
            //both liquidatable -> base has lowest ICR
            } else if (vars.baseICR <= vars.shieldedICR){
                vars.user = vars.baseNext;
                vars.troveRate = _accumulatedRate;
                vars.shielded = false;
            //both liquidatable -> shield has lowest ICR
            } else if (vars.baseICR > vars.shieldedICR) {
                vars.user = vars.shieldedNext;
                vars.troveRate = _accumulatedShieldRate;
                vars.shielded = true;
            // nothing is liquidatable
            }

            //if (vars.user == address(0)) break;

            // set corresponding pools
            liquidateInputs.currentActivePool = vars.shielded ? _activeShieldedPool : _activePool;
            liquidateInputs.defaultPool = _defaultPool;

            vars.availableLUSDNorm = vars.remainingLUSDInSPForOffsets.mul(RATE_PRECISION) / vars.troveRate;

            liquidateInputs.borrower = vars.user;
            liquidateInputs.LUSDInSPForOffsets = vars.availableLUSDNorm;
            liquidateInputs.troveRate = vars.troveRate;

            singleLiquidation = _liquidate(liquidateInputs);

            if (vars.shielded) {
                singleLiquidation.shieldedDebtToOffset = singleLiquidation.debtToOffset;
                singleLiquidation.shieldedDebtToRedistribute = singleLiquidation.debtToRedistribute;
                singleLiquidation.shieldedCollToRedistribute = singleLiquidation.collToRedistribute;
                singleLiquidation.shieldedCollToSendToSP = singleLiquidation.collToSendToSP;
                singleLiquidation.shieldedCollGasCompensation = singleLiquidation.collGasCompensation;
                singleLiquidation.shieldedLUSDGasCompensation = singleLiquidation.LUSDGasCompensation;
                singleLiquidation.shieldedCollSurplus = singleLiquidation.collSurplus;
                singleLiquidation.entireTroveShieldedDebt = singleLiquidation.entireTroveDebt;
             } else {
                singleLiquidation.baseDebtToOffset = singleLiquidation.debtToOffset;
                singleLiquidation.baseDebtToRedistribute = singleLiquidation.debtToRedistribute;
                singleLiquidation.baseCollToRedistribute = singleLiquidation.collToRedistribute;
                singleLiquidation.baseCollToSendToSP = singleLiquidation.collToSendToSP;
                singleLiquidation.baseCollGasCompensation = singleLiquidation.collGasCompensation;
                singleLiquidation.baseLUSDGasCompensation = singleLiquidation.LUSDGasCompensation;
                singleLiquidation.baseCollSurplus = singleLiquidation.collSurplus;
                singleLiquidation.entireTroveBaseDebt = singleLiquidation.entireTroveDebt;
             }

            vars.remainingLUSDInSPForOffsets = vars.remainingLUSDInSPForOffsets.sub(singleLiquidation.actualDebtToOffset);

            // Add liquidation values to their respective running totals
            totals = _addLiquidationValuesToTotals(totals, singleLiquidation);

            // move cursors
            if (vars.user == vars.shieldedNext) {
                (vars.shieldedNext, vars.shieldedICR) = _getNextLiquidatableShieldedTrove(sortedShieldedTrovesCached, _price);
            } else {
                (vars.baseNext, vars.baseICR) = _getNextLiquidatableBaseTrove(sortedTrovesCached, _price);
            }
            
            vars.i++;
        }
    }

    /*
    * Attempt to liquidate a custom list of troves provided by the caller.
    */
    function batchLiquidate(address[] memory _troveArray) public override {
        require(_troveArray.length != 0, "Liquidations: address array must not be empty");

        IActivePool activePoolCached = activePool;
        IDefaultPool defaultPoolCached = defaultPool;
        IActivePool activeShieldedPoolCached = activeShieldedPool;
        IStabilityPool stabilityPoolCached = stabilityPool;

        LocalVariables_OuterLiquidationFunction memory vars;
        LiquidationTotals memory totals;

        (, uint par) = relayer.getRateAndPar();
        // drip before getting accRate
        troveManager.drip();
        vars.accumulatedRate = troveManager.accumulatedRate();
        vars.accumulatedShieldRate = troveManager.accumulatedShieldRate();

        vars.price = priceFeed.fetchPrice();
        vars.LUSDInSPForOffsets = stabilityPoolCached.getMaxAmountToOffset();

        // all normalized
        totals = _getTotalsFromBatchLiquidate(activePoolCached, defaultPoolCached, activeShieldedPoolCached, vars.price, vars.LUSDInSPForOffsets,
                                              _troveArray, par, vars.accumulatedRate, vars.accumulatedShieldRate);

        require(totals.totalBaseDebtInSequence > 0 || totals.totalShieldedDebtInSequence > 0, "Liquidations: nothing to liquidate");

        uint totalActualBaseDebtToOffset = totals.totalBaseDebtToOffset.mul(vars.accumulatedRate).div(RATE_PRECISION);
        uint totalActualShieldedDebtToOffset = totals.totalShieldedDebtToOffset.mul(vars.accumulatedShieldRate).div(RATE_PRECISION);

        emit Offset(totalActualBaseDebtToOffset, totals.totalBaseDebtToOffset, totals.totalBaseCollToSendToSP,
                    totalActualShieldedDebtToOffset, totals.totalShieldedDebtToOffset, totals.totalShieldedCollToSendToSP);

        // offset from SP
        stabilityPoolCached.offset(totalActualBaseDebtToOffset, totals.totalBaseDebtToOffset, totals.totalBaseCollToSendToSP,
                                   totalActualShieldedDebtToOffset, totals.totalShieldedDebtToOffset, totals.totalShieldedCollToSendToSP);

        emit Redistribute(totals.totalBaseDebtToRedistribute, totals.totalBaseCollToRedistribute,
                                        totals.totalShieldedDebtToRedistribute, totals.totalShieldedCollToRedistribute);
        // batchLiquidate
        // redistribute
        rewards.redistributeDebtAndColl(totals.totalBaseDebtToRedistribute, totals.totalBaseCollToRedistribute,
                                        totals.totalShieldedDebtToRedistribute, totals.totalShieldedCollToRedistribute,
                                        vars.accumulatedRate, vars.accumulatedShieldRate);

        if (totals.totalBaseCollSurplus > 0) {
            activePoolCached.sendCollateral(address(collSurplusPool), totals.totalBaseCollSurplus);
        }
        if (totals.totalShieldedCollSurplus > 0) {
            activeShieldedPoolCached.sendCollateral(address(collSurplusPool), totals.totalShieldedCollSurplus);
        }


        // Update system snapshots
        rewards.updateSystemSnapshots_excludeCollRemainder(activePoolCached, activeShieldedPoolCached, defaultPoolCached,
                                                           totals.totalBaseCollGasCompensation.add(totals.totalShieldedCollGasCompensation));

        vars.liquidatedDebt = _actualDebt(totals.totalBaseDebtInSequence, vars.accumulatedRate) + _actualDebt(totals.totalShieldedDebtInSequence, vars.accumulatedShieldRate);
        vars.liquidatedColl = totals.totalCollInSequence.sub(totals.totalCollGasCompensation).sub(totals.totalCollSurplus);

        emit Liquidation(vars.liquidatedDebt, vars.liquidatedColl, totals.totalCollGasCompensation, totals.totalLUSDGasCompensation);

        // Send gas compensation to caller
        _sendGasCompensation(activePoolCached, msg.sender, totals.totalBaseLUSDGasCompensation, totals.totalBaseCollGasCompensation);
        _sendGasCompensation(activeShieldedPoolCached, msg.sender, totals.totalShieldedLUSDGasCompensation, totals.totalShieldedCollGasCompensation);
    }

    function _getTotalsFromBatchLiquidate
    (
        IActivePool _activePool,
        IDefaultPool _defaultPool,
        IActivePool _activeShieldedPool,
        uint _price,
        uint _LUSDInSPForOffsets,
        address[] memory _troveArray,
        uint _par,
        uint _accumulatedRate,
        uint _accumulatedShieldRate
    )
        internal
        returns(LiquidationTotals memory totals)
    {
        LocalVariables_LiquidationSequence memory vars;
        LiquidationValues memory singleLiquidation;

        LiquidateInputs memory liquidateInputs;
        liquidateInputs.price = _price;
        liquidateInputs.par = _par;

        vars.remainingLUSDInSPForOffsets = _LUSDInSPForOffsets;

        for (vars.i = 0; vars.i < _troveArray.length; vars.i++) {
            vars.user = _troveArray[vars.i];
            vars.ICR = troveManager.getCurrentICR(vars.user, _price);

            if (vars.ICR < MCR) {

                vars.shielded = troveManager.shielded(vars.user);

                vars.troveRate = vars.shielded ? _accumulatedShieldRate : _accumulatedRate;

                vars.availableLUSDNorm = vars.remainingLUSDInSPForOffsets.mul(RATE_PRECISION) / vars.troveRate;


                liquidateInputs.currentActivePool = vars.shielded ? _activeShieldedPool : _activePool;
                liquidateInputs.defaultPool = _defaultPool;

                liquidateInputs.borrower = vars.user;
                liquidateInputs.LUSDInSPForOffsets = vars.availableLUSDNorm;
                liquidateInputs.troveRate = vars.troveRate;

                singleLiquidation = _liquidate(liquidateInputs);

                if (vars.shielded) {
                    singleLiquidation.shieldedDebtToOffset = singleLiquidation.debtToOffset;
                    singleLiquidation.shieldedDebtToRedistribute = singleLiquidation.debtToRedistribute;
                    singleLiquidation.shieldedCollToRedistribute = singleLiquidation.collToRedistribute;
                    singleLiquidation.shieldedCollToSendToSP = singleLiquidation.collToSendToSP;
                    singleLiquidation.shieldedCollGasCompensation = singleLiquidation.collGasCompensation;
                    singleLiquidation.shieldedLUSDGasCompensation = singleLiquidation.LUSDGasCompensation;
                    singleLiquidation.shieldedCollSurplus = singleLiquidation.collSurplus;
                    singleLiquidation.entireTroveShieldedDebt = singleLiquidation.entireTroveDebt;
                 } else {
                    singleLiquidation.baseDebtToOffset = singleLiquidation.debtToOffset;
                    singleLiquidation.baseDebtToRedistribute = singleLiquidation.debtToRedistribute;
                    singleLiquidation.baseCollToRedistribute = singleLiquidation.collToRedistribute;
                    singleLiquidation.baseCollToSendToSP = singleLiquidation.collToSendToSP;
                    singleLiquidation.baseCollGasCompensation = singleLiquidation.collGasCompensation;
                    singleLiquidation.baseLUSDGasCompensation = singleLiquidation.LUSDGasCompensation;
                    singleLiquidation.baseCollSurplus = singleLiquidation.collSurplus;
                    singleLiquidation.entireTroveBaseDebt = singleLiquidation.entireTroveDebt;
                 }

                vars.remainingLUSDInSPForOffsets = vars.remainingLUSDInSPForOffsets.sub(singleLiquidation.actualDebtToOffset);

                // Add liquidation values to their respective running totals
                totals = _addLiquidationValuesToTotals(totals, singleLiquidation);
            }
        }
    }

    // --- Liquidation helper functions ---
    function _addLiquidationValuesToTotals(LiquidationTotals memory oldTotals, LiquidationValues memory singleLiquidation)
    internal pure returns(LiquidationTotals memory newTotals) {

        // Tally all the values with their respective running totals

        // these totals of base+shielded are used in Liquidation event
        newTotals.totalCollGasCompensation = oldTotals.totalCollGasCompensation.add(singleLiquidation.baseCollGasCompensation).add(singleLiquidation.shieldedCollGasCompensation);
        newTotals.totalLUSDGasCompensation = oldTotals.totalLUSDGasCompensation.add(singleLiquidation.baseLUSDGasCompensation).add(singleLiquidation.shieldedLUSDGasCompensation);
        newTotals.totalCollSurplus = oldTotals.totalCollSurplus.add(singleLiquidation.baseCollSurplus).add(singleLiquidation.shieldedCollSurplus);
        newTotals.totalCollInSequence = oldTotals.totalCollInSequence.add(singleLiquidation.entireTroveColl);

        newTotals.totalBaseCollGasCompensation = oldTotals.totalBaseCollGasCompensation.add(singleLiquidation.baseCollGasCompensation);
        newTotals.totalBaseLUSDGasCompensation = oldTotals.totalBaseLUSDGasCompensation.add(singleLiquidation.baseLUSDGasCompensation);
        newTotals.totalShieldedCollGasCompensation = oldTotals.totalShieldedCollGasCompensation.add(singleLiquidation.shieldedCollGasCompensation);
        newTotals.totalShieldedLUSDGasCompensation = oldTotals.totalShieldedLUSDGasCompensation.add(singleLiquidation.shieldedLUSDGasCompensation);
        // norm
        newTotals.totalBaseDebtInSequence = oldTotals.totalBaseDebtInSequence.add(singleLiquidation.entireTroveBaseDebt);
        newTotals.totalShieldedDebtInSequence = oldTotals.totalShieldedDebtInSequence.add(singleLiquidation.entireTroveShieldedDebt);
        // norm
        newTotals.totalBaseDebtToOffset = oldTotals.totalBaseDebtToOffset.add(singleLiquidation.baseDebtToOffset);
        newTotals.totalShieldedDebtToOffset = oldTotals.totalShieldedDebtToOffset.add(singleLiquidation.shieldedDebtToOffset);

        //newTotals.totalActualDebtToOffset = oldTotals.totalActualDebtToOffset.add(singleLiquidation.actualDebtToOffset);

        newTotals.totalBaseCollToSendToSP = oldTotals.totalBaseCollToSendToSP.add(singleLiquidation.baseCollToSendToSP);
        newTotals.totalShieldedCollToSendToSP = oldTotals.totalShieldedCollToSendToSP.add(singleLiquidation.shieldedCollToSendToSP);

        newTotals.totalBaseDebtToRedistribute = oldTotals.totalBaseDebtToRedistribute.add(singleLiquidation.baseDebtToRedistribute);
        newTotals.totalBaseCollToRedistribute = oldTotals.totalBaseCollToRedistribute.add(singleLiquidation.baseCollToRedistribute);

        newTotals.totalShieldedDebtToRedistribute = oldTotals.totalShieldedDebtToRedistribute.add(singleLiquidation.shieldedDebtToRedistribute);
        newTotals.totalShieldedCollToRedistribute = oldTotals.totalShieldedCollToRedistribute.add(singleLiquidation.shieldedCollToRedistribute);

        newTotals.totalBaseCollSurplus = oldTotals.totalBaseCollSurplus.add(singleLiquidation.baseCollSurplus);
        newTotals.totalShieldedCollSurplus = oldTotals.totalShieldedCollSurplus.add(singleLiquidation.shieldedCollSurplus);

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
        require(msg.sender == borrowerOperationsAddress, "Liquidations: Caller is not BO contract");
    }
}
