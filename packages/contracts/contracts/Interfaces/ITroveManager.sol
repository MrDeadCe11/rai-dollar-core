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
interface ITroveManager is ILiquityBase {
    
    // --- Events ---

    event AggregatorAddressChanged(address _newAggregatorAddress);
    event LiquidationsAddressChanged(address _newLiquidationsAddress);
    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event PriceFeedAddressChanged(address _newPriceFeedAddress);
    event LUSDTokenAddressChanged(address _newLUSDTokenAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event ActiveShieldedPoolAddressChanged(address _activeShieldedPoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event DefaultShieldedPoolAddressChanged(address _defaultShieldedPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event GasPoolAddressChanged(address _gasPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event SortedShieldedTrovesAddressChanged(address _sortedShieldedTrovesAddress);
    event LQTYTokenAddressChanged(address _lqtyTokenAddress);
    event LQTYStakingAddressChanged(address _lqtyStakingAddress);
    event RelayerAddressChanged(address _relayerAddress);

    event Liquidation(uint _liquidatedDebt, uint _liquidatedColl, uint _collGasCompensation, uint _LUSDGasCompensation);
    event Redemption(uint _attemptedLUSDAmount, uint _actualLUSDAmount, uint _collateralSent, uint _collateralFee);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, uint8 operation);
    event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, uint8 operation);
    event TroveIndexUpdated(address _borrower, uint _newIndex);
    event ShieldedTroveIndexUpdated(address _borrower, uint _newIndex);

    event AccInterestRateUpdated(uint256 rate, uint256 shieldRate);

    // --- Functions ---

    /*
    function setAddresses(
        address _aggregatorAddress,
        address _liquidationsAddress,
        address _borrowerOperationsAddress,
        address _activePoolAddress,
        address _activeShieldedPoolAddress,
        address _defaultPoolAddress,
        address _defaultShieldedPoolAddress,
        address _stabilityPoolAddress,
        address _gasPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _lusdTokenAddress,
        address _sortedTrovesAddress,
        address _sortedShieldedTrovesAddress,
        address _lqtyTokenAddress,
        address _lqtyStakingAddress,
        address _relayerAddress,
        address _collateralTokenAddress
    ) external;
    */
    function setAddresses(address[] memory _addresses) external;

    function collSurplusPool() external view returns (ICollSurplusPool);
    function stabilityPool() external view returns (IStabilityPool);
    function lusdToken() external view returns (ILUSDToken);
    function lqtyToken() external view returns (ILQTYToken);
    function lqtyStaking() external view returns (ILQTYStaking);

    function accumulatedRate() external view returns (uint);
    function accumulatedShieldRate() external view returns (uint);

    function getTroveOwnersCount() external view returns (uint);

    function getShieldedTroveOwnersCount() external view returns (uint);

    function shielded(address _borrower) external view returns (bool);

    function createTrove(address _borrower, uint _nicr, address _upperHint, address _lowerHint, bool _redemptionShield) external;

    function shieldTrove(address _borrower, address _upperHint, address _lowerHint) external;

    function unShieldTrove(address _borrower, address _upperHint, address _lowerHint) external;

    function getTroveFromTroveOwnersArray(uint _index) external view returns (address);

    function getTroveFromShieldedTroveOwnersArray(uint _index) external view returns (address);

    function getNominalICR(address _borrower) external view returns (uint);

    function getCurrentICR(address _borrower, uint _price) external view returns (uint);

    function getPendingActualLUSDDebtReward(address _borrower) external view returns (uint);

    function redeemCollateral(
        uint _LUSDAmount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        address _upperShieldedPartialRedemptionHint,
        address _lowerShieldedPartialRedemptionHint,
        uint _partialRedemptionHintNICR,
        uint _maxIterations,
        uint _maxFee
    ) external; 

    function getEntireDebtAndColl(address _borrower) external view returns (
        uint debt, 
        uint coll, 
        uint pendingLUSDDebtReward, 
        uint pendingCollateralReward
    );

    function drip() external;

    function closeTrove(address _borrower) external;

    function closeTroveLiquidation(address _borrower) external;

    function getTroveStatus(address _borrower) external view returns (uint);
    
    function getTroveStake(address _borrower) external view returns (uint);

    function getTroveDebt(address _borrower) external view returns (uint);

    function getTroveActualDebt(address _borrower) external view returns (uint);

    function getTroveColl(address _borrower) external view returns (uint);

    function getTroveDebtAndColl(address _borrower) external view returns (uint, uint);

    function setTroveStatus(address _borrower, uint num) external;

    function setTroveStake(address _borrower, uint _num) external;

    function increaseTroveColl(address _borrower, uint _collIncrease) external returns (uint);

    function decreaseTroveColl(address _borrower, uint _collDecrease) external returns (uint); 

    function increaseTroveDebt(address _borrower, uint _debtIncrease) external returns (uint); 

    function decreaseTroveDebt(address _borrower, uint _collDecrease) external returns (uint); 

    function getTCR(uint _price) external view returns (uint);

    function checkRecoveryMode(uint _price) external view returns (bool);

}
