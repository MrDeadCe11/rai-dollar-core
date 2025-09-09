// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
import "./Interfaces/IFeeRouter.sol";
import "./Interfaces/IGlobalFeeRouter.sol";
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
import "./Dependencies/TroveManagerLib.sol";
import "./Interfaces/ITroveManagerStorage.sol";
// import "./Dependencies/console.sol";

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

contract TroveManager is LiquityBase, Ownable, CheckContract, ITroveManager, ITroveManagerStorage {
    //string constant public NAME = "TroveManager";

    // --- Connected contract declarations ---

    uint internal constant REDEMPTION_FEE_FLOOR = DECIMAL_PRECISION / 1000 * 5; // 0.5%

    uint internal constant DRIP_STALENESS_THRESHOLD = 1 hours;

    uint internal constant kappa = 15 * 10**17; // 1.5

    uint public constant stakeRevenueAllocation = 25*10**16; // 25%

    // During bootsrap period redemptions are not allowed
    uint internal constant BOOTSTRAP_PERIOD = 14 days;

    // accumulated interest rate
    uint public override accumulatedRate = RATE_PRECISION;

    // accumulated interest rate for shielded troves
    uint public override accumulatedShieldRate = RATE_PRECISION;

    uint public lastAccRateUpdateTime = block.timestamp;
        // shutdown discount parameters
    uint256 constant public SEVENTY_TWO_HOURS = 259200; // 72 hours in seconds
    uint256 constant public BASE_DISCOUNT = 2e16; // 2%
    uint256 constant public MAX_DISCOUNT_ORACLE_FAILURE = DECIMAL_PRECISION; // 100%
    uint256 constant public MAX_DISCOUNT_TCR_BELOW_SCR = DECIMAL_PRECISION / 100 * 10; // 10%
    uint256 constant public MULTIPLIER = 125e16; // 1.25 * 1e18
    
    struct CollateralShutdown {
        uint256 shutdownTime;
        uint256 par;
        uint256 rate;
        bool oracleFailure;
    }

    CollateralShutdown public collateralShutdown;


    // Store the necessary data for a trove

    struct RedemptionHints {
        address upperHint;
        address lowerHint;
        address upperShieldedHint;
        address lowerShieldedHint;
        uint256 partialNICR;
    }

    // --- Variable container structs for redemptions ---

    struct RedemptionTotals {
        uint remainingLUSD;
        uint totalBaseLUSDToRedeem;
        uint totalShieldedLUSDToRedeem;
        uint totalBaseCollateralDrawn;
        uint totalShieldedCollateralDrawn;
        uint totalCollateralFee;
        uint baseCollateralFee;
        uint shieldedCollateralFee;
        uint baseCollateralToSendToRedeemer;
        uint shieldedCollateralToSendToRedeemer;
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
        uint totalRedeemed;
        uint totalCollateralDrawn;
        uint totalCollateralFee;
    }
    struct RedemptionFromTroveLocals {
        uint newColl;
        uint newDebt;
        uint normDebt;
        uint newNICR;
    }

    struct SingleRedemptionValues {
        uint LUSDLot;
        uint collateralLot;
        uint collateralFee;
        uint256 newDebt;
        uint256 newColl;
        bool cancelledPartial;
    }

    // --- Events ---
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint _stake,TroveManagerOperation _operation);
    event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, TroveManagerOperation _operation);
    event Drip(uint256 _newInterest);
    event Value(uint256 value);
    event Values(uint256 value1, uint256 value2);
    event Shutdown(bool _oracleFailure, uint256 _rate, uint256 _par, uint256 _shutdownTime);

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

        // set LiquityBase addresses
        // TODO: maybe re-order these so base contract addresses are set first or possibly pass 2 different arrays
        activePool = IActivePool(addresses[3]);
        activeShieldedPool = IActivePool(addresses[4]);
        defaultPool = IDefaultPool(addresses[5]);
        priceFeed = IPriceFeed(addresses[9]);
        relayer = IRelayer(addresses[15]);

        // set addresses using TroveManagerLib, will revert if addresses have already been set
        TroveManagerLib.setAddresses(addresses);

        /*
        // commenting these out for now to reduce contract size
        emit AggregatorAddressChanged(address(aggregator));
        emit LiquidationsAddressChanged(address(liquidations));
        emit BorrowerOperationsAddressChanged(borrowerOperationsAddress);
        emit ActivePoolAddressChanged(address(activePool));
        emit ActiveShieldedPoolAddressChanged(address(activeShieldedPool));
        emit DefaultPoolAddressChanged(address(defaultPool));
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
        */

        _renounceOwnership();
    }

    // --- Getters ---

    function getTroveStorage() internal pure returns (TroveStorage storage $) {
        assembly {
            //kecca256("raidollar.trovemanager.trovestorage")
            $_slot := 0xb4a7d751cb0b438867fefd66a43523806e84b89b85fea4b445161a0afe9bcc82
        }
    }

    function getContractsStorage() internal pure returns (ContractsStorage storage $) {
        assembly {
            //kecca256("raidollar.trovemanager.contractscache")
            $_slot := 0xd4966da17e8d83425f4f200d96021f3889de7fba79ec270c327dc6f400c90527
        }
    }

    function getTroveOwnersCount() external view override returns (uint) {
        return getTroveStorage().TroveOwners.length;
    }

    function getTroveFromTroveOwnersArray(uint _index) external view override returns (address) {
        return getTroveStorage().TroveOwners[_index];
    }

    function ShieldedTroveOwners(uint _index) external view returns (address) {
        return getTroveStorage().ShieldedTroveOwners[_index];
    }

    function TroveOwners(uint _index) external view returns (address) {
        return getTroveStorage().TroveOwners[_index];
    }

    function getShieldedTroveOwnersCount() external view override returns (uint) {
        return getTroveStorage().ShieldedTroveOwners.length;
    }

    function getTroveFromShieldedTroveOwnersArray(uint _index) external view override returns (address) {
        return getTroveStorage().ShieldedTroveOwners[_index];
    }

    // --- Redemption functions ---

    // Redeem as much collateral as possible from _borrower's Trove in exchange for LUSD up to _maxLUSDamount
    function _redeemCollateralFromTrove(
        ContractsStorage memory _contractsCache,
        address _borrower,
        uint _maxLUSDamount,
        uint _price,
        uint _par,
        RedemptionHints memory hints,
        bool _shielded,
        uint _redemptionRate
    )
        internal returns (SingleRedemptionValues memory singleRedemption)
    {
        RedemptionFromTroveLocals memory locals;
        Trove storage t = getTroveStorage().Troves[_borrower];
        // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the Trove minus the liquidation reserve
        singleRedemption.LUSDLot = LiquityMath._min(_maxLUSDamount, _actualDebt(t.debt, _shielded).sub(LUSD_GAS_COMPENSATION));

        // Get the collateralLot of equivalent value in USD
         singleRedemption.collateralLot = singleRedemption.LUSDLot.mul(_par).div(_price);

        // calculate fee for redeemed collateral
        singleRedemption.collateralFee =  _redemptionRate.mul(singleRedemption.collateralLot).div(DECIMAL_PRECISION);
        // subtract fee from collateral lot so fee stays in trove
        singleRedemption.collateralLot = singleRedemption.collateralLot.sub(singleRedemption.collateralFee);

        locals.normDebt = _normalizedDebt(singleRedemption.LUSDLot, _shielded);

        if (_actualDebt(locals.normDebt, _shielded) < _actualDebt(singleRedemption.LUSDLot, _shielded)) {
            locals.normDebt += 1;
        }

        // Decrease the debt and collateral of the current Trove according to the LUSD lot and corresponding collateral to send
        locals.newDebt = (t.debt).sub(locals.normDebt);
        locals.newColl = (t.coll).sub(singleRedemption.collateralLot);

        // Change from eq to lte
        // since sub of normalized debt above could make 1 wei less
        // and actualDebt can also round down
        //if (_actualDebt(newDebt).sub(1) <= LUSD_GAS_COMPENSATION) {
        if (_actualDebt(locals.newDebt, _shielded) <= LUSD_GAS_COMPENSATION) {
            // No debt left in the Trove (except for the liquidation reserve), therefore the trove gets closed
            _contractsCache.rewards.removeStake(_borrower);
            _closeTrove(_contractsCache, _borrower, Status.closedByRedemption);
            _redeemCloseTrove(_contractsCache, _borrower, LUSD_GAS_COMPENSATION, locals.newColl, _shielded);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.redeemCollateral);

        } else {

            singleRedemption = _reInsertTroves(_contractsCache, locals, hints, singleRedemption, _shielded, _borrower);
            // if the partial redemption is cancelled during  the reinsertion, return the singleRedemption
            if(singleRedemption.cancelledPartial) {
                return singleRedemption;
            }

            Troves[_borrower].debt = locals.newDebt;
            Troves[_borrower].coll = locals.newColl;
            rewards.updateStakeAndTotalStakes(_borrower);

            emit TroveUpdated(
                _borrower,
                locals.newDebt, locals.newColl,
                Troves[_borrower].stake,
                TroveManagerOperation.redeemCollateral
            );
        }
       
        return singleRedemption;
    }

    function _calculateSingleRedemptionValues(SingleRedemptionValues memory _singleRedemption, bool _shielded, address _borrower, uint _maxLUSDamount, uint _price, uint _par, uint _redemptionRate) internal returns (SingleRedemptionValues memory){
        bool shutdown = _isShutdown();
        // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the Trove minus the liquidation reserve
        if(shutdown) {
            _singleRedemption.LUSDLot = LiquityMath._min(_maxLUSDamount, _actualDebt(Troves[_borrower].debt, _shielded));
        } else {
            _singleRedemption.LUSDLot = LiquityMath._min(_maxLUSDamount, _actualDebt(Troves[_borrower].debt, _shielded).sub(LUSD_GAS_COMPENSATION));
        } 
        if(shutdown) {
            _singleRedemption.collateralLot = _singleRedemption.LUSDLot.mul(_par).div(DECIMAL_PRECISION.sub(_calcDiscountForShutdown()).mul(_price));
        } else {
            _singleRedemption.collateralLot = _singleRedemption.LUSDLot.mul(_par).div(_price);
        }

        if(!shutdown) {
            // calculate fee for redeemed collateral
            _singleRedemption.collateralFee =  _redemptionRate.mul(_singleRedemption.collateralLot).div(DECIMAL_PRECISION);
            // subtract fee from collateral lot so fee stays in trove
            _singleRedemption.collateralLot = _singleRedemption.collateralLot.sub(_singleRedemption.collateralFee);
        }

        return _singleRedemption;
    }

    function _reInsertTroves(ContractsCache memory _contractsCache, RedemptionFromTroveLocals memory _locals, RedemptionHints memory _hints, SingleRedemptionValues memory _singleRedemption, bool _shielded, address _borrower) internal returns (SingleRedemptionValues memory singleRedemption){
      _locals.newNICR = LiquityMath._computeNominalCR(_locals.newColl, _locals.newDebt);
            /*
            * If the provided hint is out of date, we bail since trying to reinsert without a good hint will almost
            * certainly result in running out of gas. 
            *
            * If the resultant net debt of the partial is less than the minimum, net debt we bail.
            */

            // This options would allow par drift after off-chain hint
            //if (!sorted.isValidInsertPosition(locals.newNICR, hints.upper, hints.lower)  || _getNetDebt(_actualDebt(locals.newDebt, _shielded)) < MIN_NET_DEBT) {
            if (_locals.newNICR != _hints.partialNICR || _getNetDebt(_actualDebt(_locals.newDebt, _shielded)) < MIN_NET_DEBT) {
                _singleRedemption.cancelledPartial = true;
                return _singleRedemption;
            }

            if (_shielded) {
                _contractsCache.sortedShieldedTroves.reInsert(_borrower, _locals.newNICR, _hints.upperShieldedHint, _hints.lowerShieldedHint);
                /*
                if (!sortedShieldedTroves.isValidInsertPosition(locals.newNICR, hints.upper, hints.lower) {
                    singleRedemption.cancelledPartial = true;
                    return singleRedemption;
                }
                */
            } else {
                _contractsCache.sortedTroves.reInsert(_borrower, _locals.newNICR, _hints.upperHint, _hints.lowerHint);
                /*
                if (!sortedTroves.isValidInsertPosition(locals.newNICR, hints.upper, hints.lower) {
                    singleRedemption.cancelledPartial = true;
                    return singleRedemption;
                }
                */
            }

            TroveStorage storage t = getTroveStorage().Troves[_borrower];
            t.debt = locals.newDebt;
            t.coll = locals.newColl;
            rewards.updateStakeAndTotalStakes(_borrower);

            emit TroveUpdated(
                _borrower,
                locals.newDebt, locals.newColl,
                t.stake,
                TroveManagerOperation.redeemCollateral
            );
        }
       
    //     return singleRedemption;
    // }
    
    /*
    * Called when a full redemption occurs, and closes the trove.
    * The redeemer swaps (debt - liquidation reserve) LUSD for (debt - liquidation reserve) worth of collateral, so the LUSD liquidation reserve left corresponds to the remaining debt.
    * In order to close the trove, the LUSD liquidation reserve is burned, and the corresponding debt is removed from the active pool.
    * The debt recorded on the trove's struct is zero'd elswhere, in _closeTrove.
    * Any surplus collateral left in the trove, is sent to the Coll surplus pool, and can be later claimed by the borrower.
    */
    function _redeemCloseTrove(ContractsStorage memory _contractsCache, address _borrower, uint _LUSD, uint _collateral, bool _shielded) internal {
        _contractsCache.lusdToken.burn(_contractsCache.gasPoolAddress, _LUSD);

        // TODO: is this needed?
        /*
        // subtract 1 more to ensure debt <= supply
        uint normDebt = _normalizedDebt(_LUSD);
        if (normDebt.mul(accumulatedRate).div(RATE_PRECISION) < _actualDebt(_LUSD)) {
            normDebt += 1;
        }
        */

        // send collateral from Active Pool to CollSurplus Pool
        _contractsCache.collSurplusPool.accountSurplus(_borrower, _collateral);

        if (_shielded) {
            activeShieldedPool.decreaseLUSDDebt(_normalizedDebt(_LUSD, _shielded));
            activeShieldedPool.sendCollateral(address(_contractsCache.collSurplusPool), _collateral);
        } else {
            activePool.decreaseLUSDDebt(_normalizedDebt(_LUSD, _shielded));
           activePool.sendCollateral(address(_contractsCache.collSurplusPool), _collateral);
        }

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

    // --- redeemCollateral() helpers ---------------------------------------------------------------
    function _validateFirstHint(ContractsStorage memory _contractsCache, address _first, uint256 _price, uint256 _par)
        internal
        view
        returns (bool ok, bool isShieldedList)
    {
        if (_first == address(0)) return (false, false);

        // if hint is in base list
        if (_contractsCache.sortedTroves.contains(_first)) {
            uint256 icr = _getCurrentICR(_contractsCache, _first, _price, _par);
            if (icr < MCR) return (false, false);

            // hint is redeemable, but is it first?
            address next = _contractsCache.sortedTroves.getNext(_first); // next => lower ICR
            if (next == address(0)) return (true, false);
            if (_getCurrentICR(_contractsCache, next, _price, _par) < MCR) return (true, false);
            return (false, false);
        }

        // if hint is in hielded list
        if (_contractsCache.sortedShieldedTroves.contains(_first)) {
            uint256 icr = _getCurrentICR(_contractsCache, _first, _price, _par);
            // shielded redeemable only in [MCR, HCR)
            if (icr < MCR || icr >= HCR) return (false, true);

            // hint is redeemable, but is it first?
            address next = _contractsCache.sortedShieldedTroves.getNext(_first);
            if (next == address(0)) return (true, true);
            if (_getCurrentICR(_contractsCache, next, _price, _par) < MCR) return (true, true);
            return (false, true);
        }

        return (false, false);
    }

    function _seedCursorsFromHint(ContractsStorage memory _contractsCache, address _firstHint, uint256 _price, uint256 _par)
        internal
        view
        returns (address curBase, address curSh)
    {
        // 1) Try to use the provided hint (resolve membership first)
        if (_firstHint != address(0)) {
            (bool ok, bool isSh) = _validateFirstHint(_contractsCache, _firstHint, _price, _par);
            if (ok) {
                if (isSh) curSh = _firstHint;
                else      curBase = _firstHint;
            }
        }

        // 2) Seed Base cursor if still needed
        if (curBase == address(0)) {
            address n = _contractsCache.sortedTroves.getLast();
            while (n != address(0)) {
                uint256 icr = _getCurrentICR(_contractsCache, n, _price, _par);
                if (icr >= MCR) { curBase = n; break; }
                n = _contractsCache.sortedTroves.getPrev(n); // prev => larger ICR
            }
        }

        // 3) Seed Shielded cursor if still needed
        if (curSh == address(0)) {
            address n = _contractsCache.sortedShieldedTroves.getLast();
            while (n != address(0)) {
                uint256 icr = _getCurrentICR(_contractsCache, n, _price, _par);
                if (icr >= MCR) { curSh = (icr < HCR) ? n : address(0); break; }
                n = _contractsCache.sortedShieldedTroves.getPrev(n); // prev => larger ICR
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
        ContractsStorage memory contractsCache = getContractsStorage();

        RedemptionTotals memory totals;
        RedemptionLocals memory locals;
        RedemptionHints memory hints;

        _requireValidMaxFeePercentage(_maxFeePercentage);
        _requireAfterBootstrapPeriod();

        (locals.price, ) = priceFeed.fetchPrice();

        //(, locals.par) = relayer.updateRateAndPar();
        locals.par = relayer.par();

        _requireTCRoverMCR(locals.price);

        require(_LUSDamount > 0, "TM: Amount must be gt than zero");

        _requireLUSDBalanceCoversRedemption(contractsCache.lusdToken, msg.sender, _LUSDamount);

        //locals.totalLUSDSupplyAtStart = getEntireSystemDebt(accumulatedRate, accumulatedShieldRate);
        locals.totalLUSDSupplyAtStart = contractsCache.lusdToken.totalSupply();
        assert(contractsCache.lusdToken.balanceOf(msg.sender) <= locals.totalLUSDSupplyAtStart);

        totals.remainingLUSD = _LUSDamount;

        // seed base and shielded cursors from hint or scanning tails
        (locals.curBase, locals.curSh) = _seedCursorsFromHint(contractsCache, _firstRedemptionHint, locals.price, locals.par);
        
        uint256 redemptionRate = contractsCache.aggregator.calcRateForRedemption(totals.remainingLUSD, locals.totalLUSDSupplyAtStart);

        if (_maxIterations == 0) { _maxIterations = uint(-1); }
        while (totals.remainingLUSD > 0 && _maxIterations > 0 && (locals.curBase != address(0) || locals.curSh != address(0))) {
            _maxIterations--;
            uint icrB;
            uint icrS;
            (icrB, icrS) = _selectNextBaseOrShielded(locals);

            // stop if neither candidate is eligible
            if (icrB == type(uint).max && icrS == type(uint).max) { break; }

            locals = _selectNextBorrower(locals, icrB, icrS);

            // apply pending rewards so debt is all in normalized format for redemption
            contractsCache.rewards.applyPendingRewards(locals.currentBorrower);

            // Hints object
            hints = RedemptionHints(
                _upperPartialRedemptionHint,
                _lowerPartialRedemptionHint,
                _upperShieldedPartialRedemptionHint,
                _lowerShieldedPartialRedemptionHint,
                _partialRedemptionHintNICR
            );

            // Redeem from the chosen borrower
            SingleRedemptionValues memory singleRedemption = _redeemCollateralFromTrove(
                contractsCache,
                locals.currentBorrower,
                totals.remainingLUSD,
                locals.price,
                locals.par,
                hints,
                !locals.pickBase,
                redemptionRate
            );

            if (singleRedemption.cancelledPartial) { break; }
            
            // add fee to total collateral fee            
            locals.totalCollateralFee = locals.totalCollateralFee.add(singleRedemption.collateralFee);

            totals.remainingLUSD = totals.remainingLUSD.sub(singleRedemption.LUSDLot);

            (totals, locals) = _advanceCursor(locals, totals, singleRedemption);

            // advance only the list we consumed from
        }

        require(totals.totalBaseCollateralDrawn > 0 || totals.totalShieldedCollateralDrawn > 0, "TM: Unable to redeem any amount");

        locals.totalRedeemed = totals.totalBaseLUSDToRedeem.add(totals.totalShieldedLUSDToRedeem);
        locals.totalCollateralDrawn = totals.totalBaseCollateralDrawn.add(totals.totalShieldedCollateralDrawn);
        uint256 grossCollateralDrawn = locals.totalCollateralDrawn.add(locals.totalCollateralFee);
        // Base rate update
        contractsCache.aggregator.updateBaseRateFromRedemption(
            locals.totalRedeemed, locals.totalLUSDSupplyAtStart
        );

        // Fees
        _requireUserAcceptsFee(locals.totalCollateralFee, grossCollateralDrawn, _maxFeePercentage);

        emit Redemption(_LUSDamount, locals.totalRedeemed,
                        locals.totalCollateralDrawn, locals.totalCollateralFee);

        contractsCache.lusdToken.burn(msg.sender, locals.totalRedeemed);

        if (totals.totalBaseLUSDToRedeem > 0) {
            activePool.decreaseLUSDDebt(_normalizedDebt(totals.totalBaseLUSDToRedeem, false));
            activePool.sendCollateral(msg.sender, totals.totalBaseCollateralDrawn);
        }
        if (totals.totalShieldedLUSDToRedeem > 0) {
            activeShieldedPool.decreaseLUSDDebt(_normalizedDebt(totals.totalShieldedLUSDToRedeem, true));
            activeShieldedPool.sendCollateral(msg.sender, totals.totalShieldedCollateralDrawn);
        }

        // Do these last to avoid conflict with off-chain partialNICRhint
        relayer.updateRateAndPar();
        drip();
    }

    function _advanceCursor(RedemptionLocals memory _locals, RedemptionTotals memory _totals, SingleRedemptionValues memory _singleRedemption) internal returns(RedemptionTotals memory, RedemptionLocals memory){
            if (_locals.pickBase) {
                _totals.totalBaseLUSDToRedeem = _totals.totalBaseLUSDToRedeem.add(_singleRedemption.LUSDLot);
                _totals.totalBaseCollateralDrawn = _totals.totalBaseCollateralDrawn.add(_singleRedemption.collateralLot);
                // advance cursor
                _locals.curBase = _locals.nextUserToCheck;
            } else {
                _totals.totalShieldedLUSDToRedeem = _totals.totalShieldedLUSDToRedeem.add(_singleRedemption.LUSDLot);
                _totals.totalShieldedCollateralDrawn = _totals.totalShieldedCollateralDrawn.add(_singleRedemption.collateralLot);
                // advance cursor
                _locals.curSh = _locals.nextUserToCheck;
            }

        return (_totals, _locals);
    function redeemCollateralDuringShutdown(
        uint _LUSDamount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        address _upperShieldedPartialRedemptionHint,
        address _lowerShieldedPartialRedemptionHint,
        uint _partialRedemptionHintNICR,
        uint _maxIterations,
        uint _maxFeePercentage
        ) external override {
        _requireShutdown();

    }

    function shutdown(bool _oracleFailure) external override {
       _requireCallerIsBorrowerOperations();
       if(_isShutdown()) return;
       (uint256 rate, uint256 par) = relayer.updateRateAndPar();
       drip();
       _shutdown(_oracleFailure, rate, par);
    }

    // --- Helper functions ---

    // Return the nominal collateral ratio (ICR) of a given Trove, without the price. Takes a trove's pending coll and debt rewards from redistributions into account.
    // TODO adjust for shielded
    function getNominalICR(address _borrower) public view override returns (uint) {
        return TroveManagerLib.getNominalICR(_borrower);
    }

    // Return the current collateral ratio (ICR) of a given Trove. Takes a trove's pending coll and debt rewards from redistributions into account.
    function getCurrentICR(address _borrower, uint _price) public view override returns (uint) {
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        return _getCurrentICR(contractsCache, _borrower, _price, relayer.par());
    }

    function _getCurrentICR(ContractsStorage memory _contractsCache, address _borrower, uint _price, uint _par) internal view returns (uint) {
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_contractsCache, _borrower);
        uint ICR = LiquityMath._computeCR(currentCollateral, _actualDebt(currentLUSDDebt, getTroveStorage().shielded[_borrower]), _price, _par);
        return ICR;
    }

    /*
    // not currently used, but a nice to have for UX
    function getNextICR(address _borrower, uint _price) public view override returns (uint) {
        (uint nextRate, uint nextPar) = relayer.nextRateAndPar();

        uint secondsPassed = block.timestamp - lastAccRateUpdateTime;
        bool isShielded = shielded[_borrower];
        uint accRate = accumulatedRate;

        if (isShielded) {
            nextRate = nextRate.sub(RATE_PRECISION).mul(kappa).div(DECIMAL_PRECISION).add(RATE_PRECISION);
            accRate = accumulatedShieldRate;
        }
        
        uint256 newAccRate = _calcAccumulatedRate(accRate, nextRate, secondsPassed);

        return _getNextICR(_borrower, _price, nextPar, newAccRate);
    }

    function _getNextICR(address _borrower, uint _price, uint _par, uint _accRate) internal view returns (uint) {
        (uint currentCollateral, uint currentLUSDDebt) = _getCurrentTroveAmounts(_borrower);
        uint ICR = LiquityMath._computeCR(currentCollateral,
                                          currentLUSDDebt.mul(_accRate).div(RATE_PRECISION),
                                          _price,
                                          _par);
        return ICR;
    }
    */

    // Get the borrower's pending accumulated LUSD reward, earned by their stake
    function getPendingActualLUSDDebtReward(address _borrower) public view override returns (uint) {
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        return _actualDebt(contractsCache.rewards.getPendingLUSDDebtReward(_borrower), getTroveStorage().shielded[_borrower]);
    }

    function _getCurrentTroveAmounts(ContractsStorage memory _contractsCache, address _borrower) internal view returns (uint, uint) {
        // Compute and apply pending collateral rewards
        Trove storage t = getTroveStorage().Troves[_borrower];
        return (t.coll.add(_contractsCache.rewards.getPendingCollateralReward(_borrower)),
                t.debt.add(_contractsCache.rewards.getPendingLUSDDebtReward(_borrower)));
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
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        ITroveManagerStorage.TroveStorage storage ts = getTroveStorage();
        ITroveManagerStorage.Trove storage t = ts.Troves[_borrower];
        debt = t.debt;
        coll = t.coll;

        (pendingLUSDDebtReward,
         pendingCollateralReward) = contractsCache.rewards.getPendingRewards(_borrower);

        debt = debt.add(_normalizedDebt(pendingLUSDDebtReward, ts.shielded[_borrower]));
        coll = coll.add(pendingCollateralReward);
    }

    function closeTrove(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        _closeTrove(contractsCache, _borrower, Status.closedByOwner);
    }

    function closeTroveLiquidation(address _borrower) external override {
        _requireCallerIsLiquidations();
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();    
        _closeTrove(contractsCache, _borrower, Status.closedByLiquidation);
    }

    function _closeTrove(ContractsStorage memory _contractsCache, address _borrower, Status closedStatus) internal {
        assert(closedStatus != Status.nonExistent && closedStatus != Status.active);
        TroveStorage storage ts = getTroveStorage();
        bool isShielded = ts.shielded[_borrower];

        _requireMoreThanOneTroveInSystem();
        Trove storage t = ts.Troves[_borrower];

        t.status = closedStatus;
        t.coll = 0;
        t.debt = 0;

        _contractsCache.rewards.resetTroveRewardSnapshots(_borrower);

        //_removeTroveOwner(_borrower, isShielded);
        _removeTroveOwnerFromArray(_borrower, isShielded);

        if (isShielded) {
           ts.shielded[_borrower] = false;
            _contractsCache.sortedShieldedTroves.remove(_borrower);
        } else {
            _contractsCache.sortedTroves.remove(_borrower);
        }
    }


    function _selectNextBaseOrShielded(RedemptionLocals memory locals) internal view returns (uint icrB, uint icrS) {
                // get redemption candidates
            icrB = type(uint).max;
            icrS = type(uint).max;

            if (locals.curBase != address(0)) {
                uint b = _getCurrentICR(locals.curBase, locals.price, locals.par);
                if (b >= MCR) icrB = b; // else no longer redeemable
            }

            if (locals.curSh != address(0)) {
                uint s = _getCurrentICR(locals.curSh, locals.price, locals.par);
                if (s >= MCR && s < HCR) icrS = s; // shielded only in [MCR, HCR)
            }
    }

    function _selectNextBorrower(RedemptionLocals memory locals, uint icrB, uint icrS) internal view returns (RedemptionLocals memory) {
            // pick lower-ICR eligible; tie -> prefer BASE
            locals.pickBase = (icrB <= icrS);
            locals.currentBorrower = locals.pickBase ? locals.curBase : locals.curSh;

            // Save next pointer for the chosen list before redemption possibly modifies list
            // getPrev => larger ICR
            locals.nextUserToCheck = locals.pickBase
                ? sortedTroves.getPrev(locals.currentBorrower)
                : sortedShieldedTroves.getPrev(locals.currentBorrower);

            return locals;
    }

function _addBaseTroveOwnerToArray(address _borrower) internal returns (uint128 index) {
        // Push the Troveowner to the array
        TroveOwners.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(TroveOwners.length.sub(1));
        Troves[_borrower].arrayIndex = index;

        return index;
    }

    function _addTroveOwnerToArray(address _borrower, bool _shielded) internal returns (uint128 index) {
        // Push the Troveowner to the array

        address[] storage array = _shielded ? ShieldedTroveOwners : TroveOwners;

        array.push(_borrower);

        // Record the index of the new Troveowner on their Trove struct
        index = uint128(array.length.sub(1));
        Troves[_borrower].arrayIndex = index;

        return index;
    }

    function _addShieldedTroveOwnerToArray(address _borrower) internal returns (uint128 index) {
        // Push the Troveowner to the array
        ShieldedTroveOwners.push(_borrower);

    //     // Record the index of the new Troveowner on their Trove struct
    //     index = uint128(ts.TroveOwners.length.sub(1));
    //     ts.Troves[_borrower].arrayIndex = index;

    //     return index;
    // }

    function shieldTrove(address _borrower, address _upperHint, address _lowerHint) external override {
        _requireCallerIsBorrowerOperations();
        TroveManagerLib.shieldTrove(_borrower, _upperHint, _lowerHint, accumulatedRate, accumulatedShieldRate, activePool, activeShieldedPool);
    }

    function unShieldTrove(address _borrower, address _upperHint, address _lowerHint) external override {
        _requireCallerIsBorrowerOperations();
        TroveManagerLib.unShieldTrove(_borrower, _upperHint, _lowerHint, accumulatedRate, accumulatedShieldRate, activePool, activeShieldedPool);
    }

    function createTrove(address _borrower, uint _nicr, address _upperHint, address _lowerHint, bool _redemptionShield) external override {
        _requireCallerIsBorrowerOperations();
        TroveManagerLib.createTrove(_borrower, _nicr, _upperHint, _lowerHint, _redemptionShield);

    }

    /*
    * Remove a Trove owner from the TroveOwners array, not preserving array order. Removing owner 'B' does the following:
    * [A B C D E] => [A E C D], and updates E's Trove struct to point to its new array index.
    */
    // function _removeTroveOwner(address _borrower, bool _shielded) internal {
    //     //Status troveStatus = Troves[_borrower].status;

    //     // It’s set in caller function `_closeTrove`
    //     // skipping this since all calling functions handle this responsibility
    //     //assert(troveStatus != Status.nonExistent && troveStatus != Status.active);
    //     TroveStorage storage ts = getTroveStorage();
    //     Trove storage t = ts.Troves[_borrower];
    //     uint128 index = t.arrayIndex;

    //     uint length = _shielded ? ts.ShieldedTroveOwners.length : ts.TroveOwners.length;

    //     uint idxLast = length.sub(1);

    //     assert(index <= idxLast);

    //     address addressToMove = _shielded ? ts.ShieldedTroveOwners[idxLast] : ts.TroveOwners[idxLast];
    //     ts.Troves[addressToMove].arrayIndex = index;

    //     if (_shielded) {
    //         ts.ShieldedTroveOwners[index] = addressToMove;
    //         ts.ShieldedTroveOwners.pop();
    //     } else {
    //         ts.TroveOwners[index] = addressToMove;
    //         ts.TroveOwners.pop();
    //     }

    //     emit TroveIndexUpdated(addressToMove, index, _shielded);

    // }

    function _removeTroveOwnerFromArray(address _borrower, bool _shielded) internal {
        //Status troveStatus = Troves[_borrower].status;

        // It’s set in caller function `_closeTrove`
        // skipping this since all calling functions handle this responsibility
        //assert(troveStatus != Status.nonExistent && troveStatus != Status.active);
        TroveStorage storage ts = getTroveStorage();
        uint128 index = ts.Troves[_borrower].arrayIndex;

        address[] storage array = _shielded ? ts.ShieldedTroveOwners : ts.TroveOwners;

        uint length = array.length;

        uint idxLast = length.sub(1);

        assert(index <= idxLast);

        address addressToMove = array[idxLast];
        ts.Troves[addressToMove].arrayIndex = index;

        array[index] = addressToMove;
        array.pop();

        emit TroveIndexUpdated(addressToMove, index, _shielded);

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

    function drip() public override {
        // TODO call drip() before LPers remove liquidity  and before SP depositors withdraw
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        uint interestRate = relayer.getRate();
        uint shieldedInterestRate = interestRate.sub(RATE_PRECISION).mul(kappa).div(DECIMAL_PRECISION).add(RATE_PRECISION);
        _drip(contractsCache, interestRate, shieldedInterestRate);
    }

    function _updateAccRates(uint256 newAccRate, uint256 newAccShieldRate) internal {
        accumulatedRate = newAccRate;
        accumulatedShieldRate = newAccShieldRate;
        lastAccRateUpdateTime = block.timestamp;
        emit AccInterestRateUpdated(newAccRate, newAccShieldRate);
    }

    function _drip(ContractsStorage memory _contractsCache, uint256 interestRate, uint256 shieldedInterestRate) internal {

        // can't distributetoSP() when empty
        if (_contractsCache.stabilityPool.getTotalLUSDDeposits() == 0) return;

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

        _updateAccRates(newAccRate, newAccShieldRate);

        // TODO: This logic needs to be changed for multi-TM
        // simple fix is 1. get current branch debt. 2. update rates 3. get new branch debt. 4. mint diff
        uint256 totalNewDebt = getEntireSystemDebt(newAccRate, newAccShieldRate);

        // for purpose of calculating new debt supply=totatSupply + pending in SP + pending in GlobalFeeRouter
        uint256 currentSupply = _contractsCache.lusdToken.totalSupply() + _contractsCache.stabilityPool.pendingLUSDDeposits() + _contractsCache.globalFeeRouter.pendingFees();

        uint256 newInterest = 0;

        if (totalNewDebt > currentSupply) {
            newInterest = totalNewDebt - currentSupply;
        }

        if (newInterest == 0) {
            return;
        }

         _contractsCache.feeRouter..allocateFees(newInterest);
    }

    function calcRedemptionRateForShutdown(uint _LUSDAmount, uint _totalLUSDSupply) public view override returns (uint) {
        uint256 newBaseRate = aggregator.calcRateForRedemption(_LUSDAmount, _totalLUSDSupply);
        uint256 discount = _calcDiscount(newBaseRate);
        
        return newBaseRate.mul(DECIMAL_PRECISION.sub(discount)).div(DECIMAL_PRECISION);
    }

    function _calcDiscount(uint _baseRate) internal view returns (uint) {
        
        uint timePassed = block.timestamp.sub(collateralShutdown.shutdownTime);
        
        uint256 maxDiscount = collateralShutdown.oracleFailure ? MAX_DISCOUNT_ORACLE_FAILURE : MAX_DISCOUNT_TCR_BELOW_SCR;

        if (timePassed >= SEVENTY_TWO_HOURS) {
            return maxDiscount;
        }

        return timePassed.mul(maxDiscount).div(SEVENTY_TWO_HOURS);
    }

    function _shutdown(bool _oracleFailure, uint256 _rate, uint256 _par) internal {
        collateralShutdown.shutdownTime = block.timestamp;
        collateralShutdown.par = _par;
        collateralShutdown.rate = _rate;
        collateralShutdown.oracleFailure = _oracleFailure;
        emit Shutdown(_oracleFailure, _rate, _par, collateralShutdown.shutdownTime);
    }

    function calcRedemptionRateForShutdown(uint _LUSDAmount, uint _totalLUSDSupply) public view override returns (uint) {
        uint256 newBaseRate = aggregator.calcRateForRedemption(_LUSDAmount, _totalLUSDSupply);
        uint256 discount = _calcDiscount(newBaseRate);
        
        return newBaseRate.mul(DECIMAL_PRECISION.sub(discount)).div(DECIMAL_PRECISION);
    }

    function _calcDiscount(uint _baseRate) internal view returns (uint) {
        
        uint timePassed = block.timestamp.sub(collateralShutdown.shutdownTime);
        
        uint256 maxDiscount = collateralShutdown.oracleFailure ? MAX_DISCOUNT_ORACLE_FAILURE : MAX_DISCOUNT_TCR_BELOW_SCR;

        if (timePassed >= SEVENTY_TWO_HOURS) {
            return maxDiscount;
        }

        return timePassed.mul(maxDiscount).div(SEVENTY_TWO_HOURS);
    }

    function _shutdown(bool _oracleFailure, uint256 _rate, uint256 _par) internal {
        collateralShutdown.shutdownTime = block.timestamp;
        collateralShutdown.par = _par;
        collateralShutdown.rate = _rate;
        collateralShutdown.oracleFailure = _oracleFailure;
        emit Shutdown(_oracleFailure, _rate, _par, collateralShutdown.shutdownTime);
    }


    function _calcDiscountForShutdown() internal view returns (uint) {
        
        uint timePassed = block.timestamp.sub(collateralShutdown.shutdownTime);
        
        uint256 maxDiscount = collateralShutdown.oracleFailure ? MAX_DISCOUNT_ORACLE_FAILURE : MAX_DISCOUNT_TCR_BELOW_SCR;

        if (timePassed >= SEVENTY_TWO_HOURS) {
            return maxDiscount;
        }

        return timePassed.mul(maxDiscount).div(SEVENTY_TWO_HOURS);
    }

    function _shutdown(bool _oracleFailure, uint256 _rate, uint256 _par) internal {
        collateralShutdown.shutdownTime = block.timestamp;
        collateralShutdown.par = _par;
        collateralShutdown.rate = _rate;
        collateralShutdown.oracleFailure = _oracleFailure;
        emit Shutdown(_oracleFailure, _rate, _par, collateralShutdown.shutdownTime);
    }

    // External view wrapper
    function calcAccumulatedRate(uint256 accRate, uint256 interestRate, uint256 secondsPassed) external pure returns (uint256) {
        return _calcAccumulatedRate(accRate, interestRate, secondsPassed);
    }

    // Internal rate compounding function
    function _calcAccumulatedRate(uint256 accRate, uint256 interestRate, uint256 secondsPassed) internal pure returns (uint256) {
        return accRate * LiquityMath._rpower(interestRate, secondsPassed, RATE_PRECISION) / RATE_PRECISION;
    }

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
        require(msg.sender == getContractsStorage().borrowerOperationsAddress, "TM: Caller is not BO");
    }

    function _requireCallerIsBorrowerOperationsOrRewards() internal view {
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        require(msg.sender == contractsCache.borrowerOperationsAddress || msg.sender == address(contractsCache.rewards),
        "TroveManager: Caller is not BO or Rewards contract");
    }

    function _requireCallerIsLiquidations() internal view {
        require(msg.sender == address(getContractsStorage().liquidations), "TM: Caller is not Liq");
    }

    function _requireCallerIsRewards() internal view {
        require(msg.sender == address(getContractsStorage().rewards), "TMr: Caller is not Rewards");
    }

    function _requireLUSDBalanceCoversRedemption(ILUSDToken _lusdToken, address _redeemer, uint _amount) internal view {
        require(_lusdToken.balanceOf(_redeemer) >= _amount, "TM: Requested redemption amount must be <= user's balance");
    }

    function _requireMoreThanOneTroveInSystem() internal view {
        ITroveManagerStorage.ContractsStorage memory contractsCache = getContractsStorage();
        // original check
        //require (TroveOwnersArrayLength > 1 && sortedTroves.getSize() > 1, "TroveManager: Only one trove in the system");
        uint total = contractsCache.sortedTroves.getSize() + contractsCache.sortedShieldedTroves.getSize();
        require(total > 1, "Only one trove in the system");
    }

    function _requireTCRoverMCR(uint _price) internal view {
        if(!_isShutdown()) {
        require(_getTCR(_price) >= MCR, "TM: Cannot redeem when TCR < MCR");
        }
    }

    function _requireAfterBootstrapPeriod() internal view {
        uint systemDeploymentTime = getContractsStorage().lqtyToken.getDeploymentStartTime();
        require(block.timestamp >= systemDeploymentTime.add(BOOTSTRAP_PERIOD), "TM: Redemptions not allowed during bootstrap");
    }

    function _requireValidMaxFeePercentage(uint _maxFeePercentage) internal pure {
        require(_maxFeePercentage >= REDEMPTION_FEE_FLOOR && _maxFeePercentage <= DECIMAL_PRECISION,
            "Max fee percentage must be between 0.5% and 100%");
    }

    function _requireNotShutdown() internal view {
        require(!_isShutdown(), "TM: Collateral is shutdown");
    }

    function _requireShutdown() internal view {
        require(_isShutdown(), "TM: Collateral is not shutdown");
    }

    function _isShutdown() internal view returns (bool) {
        return collateralShutdown.shutdownTime != 0;
    }

    function getEntireSystemDebt() public view override returns (uint) {
        return getEntireSystemDebt(accumulatedRate, accumulatedShieldRate);
    }

    // --- Trove property getters ---

    function getTroveStatus(address _borrower) external view override returns (uint) {
        return uint(getTroveStorage().Troves[_borrower].status);
    }

    function getTroveStake(address _borrower) external view override returns (uint) {
        return getTroveStorage().Troves[_borrower].stake;
    }

    function getTroveDebt(address _borrower) external view override returns (uint) {
        return getTroveStorage().Troves[_borrower].debt;
    }

    function getTroveActualDebt(address _borrower) external view override returns (uint) {
        TroveStorage storage ts = getTroveStorage();
        return _actualDebt(ts .Troves[_borrower].debt, ts .shielded[_borrower]);
    }

    function getTroveColl(address _borrower) external view override returns (uint) {
        return getTroveStorage().Troves[_borrower].coll;
    }

    function getTroveDebtAndColl(address _borrower) external view override returns (uint, uint) {
        TroveStorage storage ts = getTroveStorage();
        return (ts.Troves[_borrower].debt, ts.Troves[_borrower].coll);
    }

    // --- Trove property setters, called by BorrowerOperations ---

    function setTroveStatus(address _borrower, uint _num) external override {
        _requireCallerIsBorrowerOperations();
        getTroveStorage().Troves[_borrower].status = Status(_num);
    }

    function setTroveStake(address _borrower, uint _num) external override {
        _requireCallerIsRewards();
        getTroveStorage().Troves[_borrower].stake = _num;
    }

    function increaseTroveColl(address _borrower, uint _collIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperationsOrRewards();
        Trove storage t = getTroveStorage().Troves[_borrower];
        uint newColl = t.coll.add(_collIncrease);
        t.coll = newColl;
        return newColl;
    }

    function decreaseTroveColl(address _borrower, uint _collDecrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        Trove storage t = getTroveStorage().Troves[_borrower];
        uint newColl = t.coll.sub(_collDecrease);
        t.coll = newColl;
        return newColl;
    }

    function increaseTroveDebt(address _borrower, uint _debtIncrease) external override returns (uint) {
        _requireCallerIsBorrowerOperationsOrRewards();
        Trove storage t = getTroveStorage().Troves[_borrower];
        uint newDebt = t.debt.add(_debtIncrease);
        t.debt = newDebt;
        return newDebt;
    }

    function decreaseTroveDebt(address _borrower, uint _debtDecrease) external override returns (uint) {
        _requireCallerIsBorrowerOperations();
        Trove storage t = getTroveStorage().Troves[_borrower];
        uint newDebt = t.debt.sub(_debtDecrease);
        t.debt = newDebt;
        return newDebt;
    }

    // --- Public contract getters ---

    function collSurplusPool() external view override returns (ICollSurplusPool) {
        return getContractsStorage().collSurplusPool;
    }

    function lqtyStaking() external view override returns (ILQTYStaking) {
        return getContractsStorage().lqtyStaking;
    }
    
    function lusdToken() external view override returns (ILUSDToken) {
        return getContractsStorage().lusdToken;
    }

    function lqtyToken() external view override returns (ILQTYToken) {
        return getContractsStorage().lqtyToken;
    }

    function stabilityPool() external view override returns (IStabilityPool) {
        return getContractsStorage().stabilityPool;
    }

    function feeRouter() external view returns (IFeeRouter) {
        return getContractsStorage().feeRouter;
    }
    
    function shielded(address _borrower) external view override returns (bool) {
        return getTroveStorage().shielded[_borrower];
    }

    function sortedTroves() external view returns (ISortedTroves) {
        return getContractsStorage().sortedTroves;
    }

    function sortedShieldedTroves() external view returns (ISortedTroves) {
        return getContractsStorage().sortedShieldedTroves;
    }

    function borrowerOperationsAddress() external view returns (address) {
        return getContractsStorage().borrowerOperationsAddress;
    }

    function Troves(address _borrower) external view returns
    (uint debt, uint coll, uint stake, uint8 status, uint128 arrayIndex)
    {
    Trove storage t = getTroveStorage().Troves[_borrower];
    return (t.debt, t.coll, t.stake, uint8(t.status), t.arrayIndex);
    }
}
