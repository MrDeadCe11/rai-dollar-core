// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ILiquityBase.sol";
import "./IStabilityPool.sol";
import "./IActivePool.sol";
import "./IDefaultPool.sol";
import "./ILUSDToken.sol";
import "./ILQTYToken.sol";
import "./ILQTYStaking.sol";
import "./IRelayer.sol";
import "./ICollSurplusPool.sol";

// Common interface for the Trove Manager.
interface IRewards is ILiquityBase {
    
    // --- Events ---

    event LiquidationsAddressChanged(address _newLiquidationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);

    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, uint8 operation);
    event TotalStakesUpdated(uint _newTotalStakes);
    event SystemSnapshotsUpdated(uint _totalStakesSnapshot, uint _totalCollateralSnapshot);
    event LTermsUpdated(uint _L_Coll, uint _L_LUSDDebt);
    event ShieldedLTermsUpdated(uint _L_CollShielded, uint _L_LUSDDebtShielded);
    event TroveSnapshotsUpdated(uint _L_Coll, uint _L_CollShielded, uint _L_LUSDDebt, uint _L_LUSDDebtShielded);

    // --- Functions ---

    function setAddresses(
        address _troveManagerAddress,
        address _liquidationsAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _activeShieldedPoolAddress,
        address _defaultPoolAddress,
        address _defaultShieldedPoolAddress
    ) external;

    function redistributeDebtAndColl(uint _debt, uint _coll, uint _shieldedDebt, uint _shieldedColl) external;

    function updateSystemSnapshots_excludeCollRemainder(IActivePool _activePool, IActivePool _activeShieldedPool,
                                                        IDefaultPool _defaultPool, IDefaultPool _defaultShieldedPool,
                                                        uint _collRemainder) external;

    function movePendingTroveRewardsToActivePool(IActivePool _activePool, IDefaultPool _defaultPool,
                                                  uint _LUSD, uint _collateral) external;

    function updateStakeAndTotalStakes(address _borrower) external returns (uint);

    function updateTroveRewardSnapshots(address _borrower) external;

    function applyPendingRewards(address _borrower) external;

    function resetTroveRewardSnapshots(address _borrower) external;

    function getPendingRewards(address _borrower) external view returns (uint, uint);

    function getPendingCollateralReward(address _borrower) external view returns (uint);

    function getPendingBaseCollateralReward(address _borrower) external view returns (uint);
    function getPendingShieldedCollateralReward(address _borrower) external view returns (uint);

    function getPendingLUSDDebtReward(address _borrower) external view returns (uint);
    function getPendingBaseLUSDDebtReward(address _borrower) external view returns (uint);
    function getPendingShieldedLUSDDebtReward(address _borrower) external view returns (uint);

    function getPendingActualLUSDDebtReward(address _borrower) external view returns (uint);

    function hasPendingRewards(address _borrower) external view returns (bool);

    //function hasPendingBaseRewards(address _borrower) external view returns (bool);
    //function hasPendingShieldedRewards(address _borrower) external view returns (bool);

    function removeStake(address _borrower) external;
}
