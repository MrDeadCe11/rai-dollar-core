// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IRewards.sol";
import "./Interfaces/ILiquidations.sol";
import "./Interfaces/IActivePool.sol";
import "./Interfaces/IDefaultPool.sol";
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

contract Rewards is LiquityBase, Ownable, CheckContract, IRewards {
    string constant public NAME = "Rewards";

    // --- Connected contract declarations ---

    ITroveManager public troveManager;

    address public liquidationsAddress;

    address public borrowerOperationsAddress;

    uint public totalStakes;

    // Snapshot of the value of totalStakes, taken immediately after the latest liquidation
    uint public totalStakesSnapshot;

    // Snapshot of the total collateral across the ActivePool and DefaultPool, immediately after the latest liquidation.
    uint public totalCollateralSnapshot;

    /*
    * L_Coll and L_LUSDDebt track the sums of accumulated liquidation rewards per unit staked. During its lifetime, each stake earns:
    *
    * An collateral gain of ( stake * [L_Coll - L_Coll(0)] )
    * A LUSDDebt increase  of ( stake * [L_LUSDDebt - L_LUSDDebt(0)] )
    *
    * Where L_Coll(0) and L_LUSDDebt(0) are snapshots of L_Coll and L_LUSDDebt for the active Trove taken at the instant the stake was made
    */
    uint public L_Coll;
    uint public L_LUSDDebt;
    uint public L_CollShielded;
    uint public L_LUSDDebtShielded;

    // Map addresses with active troves to their RewardSnapshot
    mapping (address => RewardSnapshot) public rewardSnapshots;

    // Object containing the collateral and LUSD snapshots for a given active trove
    struct RewardSnapshot { uint collateral; uint LUSDDebt; uint shieldedCollateral ;uint shieldedLUSDDebt;}

    // Error trackers for the trove redistribution calculation
    uint public lastCollateralError_Redistribution;
    uint public lastLUSDDebtError_Redistribution;

    uint public lastCollateralError_Redistribution_Shielded;
    uint public lastLUSDDebtError_Redistribution_Shielded;

    struct ContractsCache {
        IActivePool activePool;
        IActivePool activeShieldedPool;
        IDefaultPool defaultPool;
        IDefaultPool defaultShieldedPool;
    }

    enum Status {
        nonExistent,
        active,
        closedByOwner,
        closedByLiquidation,
        closedByRedemption
    }


    enum TroveManagerOperation {
        applyPendingRewards,
        liquidate,
        redeemCollateral
    }


    // --- Dependency setter ---

    function setAddresses(
        address _troveManagerAddress,
        address _liquidationsAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _activeShieldedPoolAddress,
        address _defaultPoolAddress,
        address _defaultShieldedPoolAddress
    )
        external
        override
        onlyOwner
    {
        /*
        address _aggregatorAddress = addresses[0];
        address _liquidationsAddress = addresses[1];
        address _borrowerOperationsAddress = addresses[2];
        address _activePoolAddress = addresses[3];
        address _activeShieldedPoolAddress = addresses[4];
        address _defaultPoolAddress = addresses[5];
        address _defaultShieldedPoolAddress = addresses[6];
        address _gasPoolAddress = addresses[8];
        address _collSurplusPoolAddress = addresses[9];
        address _priceFeedAddress = addresses[10];
        address _collateralTokenAddress = addresses[17];
        */

        checkContract(_troveManagerAddress);
        checkContract(_liquidationsAddress);
        checkContract(_borrowerOperationsAddress);
        checkContract(_activePoolAddress);
        checkContract(_activeShieldedPoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_defaultShieldedPoolAddress);

        troveManager = ITroveManager(_troveManagerAddress);
        liquidationsAddress = _liquidationsAddress;
        borrowerOperationsAddress = _borrowerOperationsAddress;
        activePool = IActivePool(_activePoolAddress);
        activeShieldedPool = IActivePool(_activeShieldedPoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        defaultShieldedPool = IDefaultPool(_defaultShieldedPoolAddress);

        emit TroveManagerAddressChanged(address(_troveManagerAddress));
        emit LiquidationsAddressChanged(liquidationsAddress);
        emit BorrowerOperationsAddressChanged(borrowerOperationsAddress);

        _renounceOwnership();
    }

    // --- Getters ---

    // Move a Trove's pending debt and collateral rewards from distributions, from the Default Pools to the Active Pools
    function movePendingTroveRewardsToActivePools(IActivePool _activePool, IDefaultPool _defaultPool, 
                                                 IActivePool _activeShieldedPool, IDefaultPool _defaultShieldedPool,
                                                 uint _LUSD, uint _ETH,
                                                 uint _shieldedLUSD, uint _shieldedETH) external override {
        _requireCallerIsLiquidations();
        _movePendingTroveRewardsToActivePool(_activePool, _defaultPool, _LUSD, _ETH);
        _movePendingTroveRewardsToActivePool(_activeShieldedPool, _defaultShieldedPool, _shieldedLUSD, _shieldedETH);
    }

    // Move a Trove's pending debt and collateral rewards from distributions, from the Default Pool to the Active Pool
    function _movePendingTroveRewardsToActivePool(IActivePool _activePool, IDefaultPool _defaultPool,
                                                  uint _LUSD, uint _collateral) internal {
        _defaultPool.decreaseLUSDDebt(_LUSD);
        _activePool.increaseLUSDDebt(_LUSD);
        _defaultPool.sendCollateralToActivePool(_collateral);
    }

    function applyPendingRewards(address _borrower) external override {
        // TODO drip here?
        _requireCallerIsBorrowerOperationsOrTM();
        _requireTroveIsActive(_borrower);

        bool shielded = troveManager.shielded(_borrower);
        _applyPendingBaseRewards(_borrower, shielded);
        _applyPendingShieldedRewards(_borrower, shielded);
    }

    function _convertShieldedToBaseDebt(uint _shieldedDebt) internal returns (uint baseDebt) {
        baseDebt = _shieldedDebt * troveManager.accumulatedShieldRate() / troveManager.accumulatedRate();
    }

    function _convertBaseToShieldedDebt(uint _baseDebt) internal returns (uint shieldedDebt) {
        shieldedDebt = _baseDebt * troveManager.accumulatedRate() / troveManager.accumulatedShieldRate();
    }

    // Add the borrowers's coll and debt rewards earned from redistributions, to their Trove
    function _applyPendingBaseRewards(address _borrower, bool _shielded) internal {
        if (hasPendingBaseRewards(_borrower)) {
            // Compute pending rewards
            uint pendingCollateralReward = getPendingBaseCollateralReward(_borrower);
            uint pendingLUSDDebtReward = getPendingBaseLUSDDebtReward(_borrower);

            if (_shielded) {
                pendingLUSDDebtReward = _convertBaseToShieldedDebt(pendingLUSDDebtReward);
            }

            // Apply pending rewards to trove's state
            //Troves[_borrower].coll = Troves[_borrower].coll.add(pendingCollateralReward);
            //Troves[_borrower].debt = Troves[_borrower].debt.add(pendingLUSDDebtReward);
            troveManager.increaseTroveColl(_borrower, pendingCollateralReward);
            troveManager.increaseTroveDebt(_borrower, pendingLUSDDebtReward);

            _updateTroveRewardSnapshots(_borrower);

            // Transfer from DefaultPool to ActivePool
            _movePendingTroveRewardsToActivePool(activePool, defaultPool, pendingLUSDDebtReward, pendingCollateralReward);

            // TODO improve
            (uint debt, uint coll) = troveManager.getTroveDebtAndColl(_borrower);
            uint stake = troveManager.getTroveStake(_borrower);

            emit TroveUpdated(
                _borrower,
                debt,
                coll,
                stake,
                uint8(TroveManagerOperation.applyPendingRewards)
            );
        }
    }
    // Add the borrowers's coll and debt rewards earned from redistributions, to their Trove
    function _applyPendingShieldedRewards(address _borrower, bool _shielded) internal {
        if (hasPendingShieldedRewards(_borrower)) {

            // Compute pending rewards
            uint pendingCollateralReward = getPendingShieldedCollateralReward(_borrower);
            uint pendingLUSDDebtReward = getPendingShieldedLUSDDebtReward(_borrower);

            if (!_shielded) {
                pendingLUSDDebtReward = _convertShieldedToBaseDebt(pendingLUSDDebtReward);
            }

            // Apply pending rewards to trove's state
            troveManager.increaseTroveColl(_borrower, pendingCollateralReward);
            troveManager.increaseTroveDebt(_borrower, pendingLUSDDebtReward);

            _updateTroveRewardSnapshots(_borrower);

            // Transfer from DefaultPool to ActivePool
            _movePendingTroveRewardsToActivePool(activeShieldedPool, defaultShieldedPool, pendingLUSDDebtReward, pendingCollateralReward);

            // TODO improve
            (uint debt, uint coll) = troveManager.getTroveDebtAndColl(_borrower);
            uint stake = troveManager.getTroveStake(_borrower);

            emit TroveUpdated(
                _borrower,
                debt,
                coll,
                stake,
                uint8(TroveManagerOperation.applyPendingRewards)
            );
        }
    }

    // Update borrower's snapshots of L_Coll and L_LUSDDebt to reflect the current values
    function updateTroveRewardSnapshots(address _borrower) external override {
        _requireCallerIsBorrowerOperations();
       return _updateTroveRewardSnapshots(_borrower);
    }

    function _updateTroveRewardSnapshots(address _borrower) internal {
        rewardSnapshots[_borrower].collateral = L_Coll;
        rewardSnapshots[_borrower].LUSDDebt = L_LUSDDebt;
        rewardSnapshots[_borrower].shieldedCollateral = L_CollShielded;
        rewardSnapshots[_borrower].shieldedLUSDDebt = L_LUSDDebtShielded;
        emit TroveSnapshotsUpdated(L_Coll, L_CollShielded, L_LUSDDebt, L_LUSDDebtShielded);
    }

    function resetTroveRewardSnapshots(address _borrower) external override {
        rewardSnapshots[_borrower].collateral = 0;
        rewardSnapshots[_borrower].LUSDDebt = 0;
        rewardSnapshots[_borrower].shieldedCollateral = 0;
        rewardSnapshots[_borrower].shieldedLUSDDebt = 0;
    }

    function getPendingCollateralReward(address _borrower) public view override returns (uint) {
        return getPendingBaseCollateralReward(_borrower).add(getPendingShieldedCollateralReward(_borrower));
    }

    // Get the borrower's pending accumulated Collateral reward, earned by their stake
    function getPendingBaseCollateralReward(address _borrower) public view override returns (uint) {
        uint snapshotCollateral = rewardSnapshots[_borrower].collateral;
        uint rewardPerUnitStaked = L_Coll.sub(snapshotCollateral);

        if ( rewardPerUnitStaked == 0 || troveManager.getTroveStatus(_borrower) != uint(Status.active)) { return 0; }

        uint stake = troveManager.getTroveStake(_borrower);

        uint pendingCollateralReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingCollateralReward;
    }
    // Get the borrower's pending accumulated shielded Collateral reward, earned by their stake
    function getPendingShieldedCollateralReward(address _borrower) public view override returns (uint) {
        uint snapshotCollateral = rewardSnapshots[_borrower].shieldedCollateral;
        uint rewardPerUnitStaked = L_CollShielded.sub(snapshotCollateral);

        if ( rewardPerUnitStaked == 0 || troveManager.getTroveStatus(_borrower) != uint(Status.active)) { return 0; }

        uint stake = troveManager.getTroveStake(_borrower);

        uint pendingCollateralReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingCollateralReward;
    }
    
    function getPendingLUSDDebtReward(address _borrower) public view override returns (uint) {
        return getPendingBaseLUSDDebtReward(_borrower).add(getPendingShieldedLUSDDebtReward(_borrower));
    }
    // Get the borrower's pending accumulated LUSD reward, earned by their stake
    function getPendingBaseLUSDDebtReward(address _borrower) public view override returns (uint) {
        uint snapshotLUSDDebt = rewardSnapshots[_borrower].LUSDDebt;
        uint rewardPerUnitStaked = L_LUSDDebt.sub(snapshotLUSDDebt);

        if ( rewardPerUnitStaked == 0 || troveManager.getTroveStatus(_borrower) != uint(Status.active)) { return 0; }

        uint stake = troveManager.getTroveStake(_borrower);

        uint pendingLUSDDebtReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingLUSDDebtReward;
    }
    // Get the borrower's pending accumulated shielded LUSD reward, earned by their stake
    function getPendingShieldedLUSDDebtReward(address _borrower) public view override returns (uint) {
        uint snapshotShieldedLUSDDebt = rewardSnapshots[_borrower].shieldedLUSDDebt;
        uint rewardPerUnitStaked = L_LUSDDebtShielded.sub(snapshotShieldedLUSDDebt);

        if ( rewardPerUnitStaked == 0 || troveManager.getTroveStatus(_borrower) != uint(Status.active)) { return 0; }

        uint stake = troveManager.getTroveStake(_borrower);

        uint pendingShieldedLUSDDebtReward = stake.mul(rewardPerUnitStaked).div(DECIMAL_PRECISION);

        return pendingShieldedLUSDDebtReward;
    }

    // Get the borrower's pending accumulated LUSD reward, earned by their stake
    // TODO improve
    function getPendingActualLUSDDebtReward(address _borrower) public view override returns (uint) {
        //return _actualDebt(getPendingLUSDDebtReward(_borrower), shielded[_borrower]);
        return troveManager.getPendingActualLUSDDebtReward(_borrower);
    }

    function hasPendingRewards(address _borrower) public view override returns (bool) {
        return hasPendingBaseRewards(_borrower) || hasPendingShieldedRewards(_borrower);
    }

    function hasPendingBaseRewards(address _borrower) public view override returns (bool) {
        /*
        * A Trove has pending rewards if its snapshot is less than the current rewards per-unit-staked sum:
        * this indicates that rewards have occured since the snapshot was made, and the user therefore has
        * pending rewards
        */
        if (troveManager.getTroveStatus(_borrower) != uint(Status.active)) {return false;}
       
        return (rewardSnapshots[_borrower].collateral < L_Coll);
    }
    function hasPendingShieldedRewards(address _borrower) public view override returns (bool) {
        /*
        * A Trove has pending rewards if its snapshot is less than the current rewards per-unit-staked sum:
        * this indicates that rewards have occured since the snapshot was made, and the user therefore has
        * pending rewards
        */
        if (troveManager.getTroveStatus(_borrower) != uint(Status.active)) {return false;}
       
        return (rewardSnapshots[_borrower].collateral < L_CollShielded);
    }

    function removeStake(address _borrower) external override {
        _requireCallerIsBOorLiqOrTM();
        return _removeStake(_borrower);
    }

    // Remove borrower's stake from the totalStakes sum, and set their stake to 0
    function _removeStake(address _borrower) internal {
        uint stake = troveManager.getTroveStake(_borrower);
        totalStakes = totalStakes.sub(stake);
        troveManager.setTroveStake(_borrower, 0);
    }

    function updateStakeAndTotalStakes(address _borrower) external override returns (uint) {
        _requireCallerIsBorrowerOperationsOrTM();
        return _updateStakeAndTotalStakes(_borrower);
    }

    // Update borrower's stake based on their latest collateral value
    function _updateStakeAndTotalStakes(address _borrower) internal returns (uint) {
        uint newStake = _computeNewStake(troveManager.getTroveColl(_borrower));
        uint oldStake = troveManager.getTroveStake(_borrower);
        troveManager.setTroveStake(_borrower, newStake);

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
    function redistributeDebtAndColl(uint _debt, uint _coll, uint _shieldedDebt, uint _shieldedColl) external override {
        _requireCallerIsLiquidations();
        _redistributeDebtAndColl(_debt, _coll);
        _redistributeShieldedDebtAndColl(_shieldedDebt, _shieldedColl);
    }
    // norm debt
    function _redistributeDebtAndColl(uint _debt, uint _coll) internal {
        if (_debt == 0) { return; }

        /*
        * Add distributed coll and debt rewards-per-unit-staked to the running totals. Division uses a "feedback"
        * error correction, to keep the cumulative error low in the running totals L_Coll and L_LUSDDebt:
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
        L_Coll = L_Coll.add(collateralRewardPerUnitStaked);
        L_LUSDDebt = L_LUSDDebt.add(LUSDDebtRewardPerUnitStaked);

        emit LTermsUpdated(L_Coll, L_LUSDDebt);

        // Transfer coll and debt from ActivePool to DefaultPool
        activePool.decreaseLUSDDebt(_debt);
        defaultPool.increaseLUSDDebt(_debt);
        activePool.sendCollateral(address(defaultPool), _coll);
    }
    function _redistributeShieldedDebtAndColl(uint _debt, uint _coll) internal {
        if (_debt == 0) { return; }

        /*
        * Add distributed coll and debt rewards-per-unit-staked to the running totals. Division uses a "feedback"
        * error correction, to keep the cumulative error low in the running totals L_Coll and L_LUSDDebt:
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

        lastCollateralError_Redistribution_Shielded = collateralNumerator.sub(collateralRewardPerUnitStaked.mul(totalStakes));
        lastLUSDDebtError_Redistribution_Shielded = LUSDDebtNumerator.sub(LUSDDebtRewardPerUnitStaked.mul(totalStakes));

        // Add per-unit-staked terms to the running totals
        L_CollShielded = L_Coll.add(collateralRewardPerUnitStaked);
        L_LUSDDebtShielded = L_LUSDDebt.add(LUSDDebtRewardPerUnitStaked);

        emit ShieldedLTermsUpdated(L_CollShielded, L_LUSDDebtShielded);

        // Transfer coll and debt from ActivePool to DefaultPool
        activeShieldedPool.decreaseLUSDDebt(_debt);
        defaultShieldedPool.increaseLUSDDebt(_debt);
        activeShieldedPool.sendCollateral(address(defaultShieldedPool), _coll);
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
    function updateSystemSnapshots_excludeCollRemainder(IActivePool _activePool, IActivePool _activeShieldedPool,
                                                        IDefaultPool _defaultPool, IDefaultPool _defaultShieldedPool,
                                                        uint _collRemainder) external override {
        _requireCallerIsLiquidations();

        totalStakesSnapshot = totalStakes;

        uint activeBaseColl = _activePool.getCollateral();
        uint liquidatedBaseColl = _defaultPool.getCollateral();
        uint activeShieldedColl = _activeShieldedPool.getCollateral();
        uint liquidatedShieldedColl = _defaultShieldedPool.getCollateral();

        totalCollateralSnapshot = activeBaseColl.add(activeShieldedColl).sub(_collRemainder).add(liquidatedBaseColl).add(liquidatedShieldedColl);

        emit SystemSnapshotsUpdated(totalStakesSnapshot, totalCollateralSnapshot);
    }

    // --- 'require' wrapper functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(msg.sender == borrowerOperationsAddress, "Rewards: Caller is not BO contract");
    }

    function _requireCallerIsBorrowerOperationsOrTM() internal view {
        require(msg.sender == borrowerOperationsAddress ||
                msg.sender == address(troveManager),
        "Rewards: Caller is not BO or TM contract");
    }

    function _requireCallerIsLiquidations() internal view {
        require(msg.sender == liquidationsAddress, "TroveManager: Caller is not Liquidations contract");
    }

    function _requireCallerIsBOorLiqOrTM() internal view {
        require(msg.sender == borrowerOperationsAddress ||
                msg.sender == address(troveManager) || 
                msg.sender == liquidationsAddress,
        "TroveManager: Caller is not BO or Liq or TM contract");
    }

    function _requireTroveIsActive(address _borrower) internal view {
        require(troveManager.getTroveStatus(_borrower) == uint(Status.active), "Rewards: Trove does not exist or is closed");
    }


}
