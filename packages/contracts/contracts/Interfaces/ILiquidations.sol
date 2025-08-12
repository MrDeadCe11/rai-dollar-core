// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ILiquityBase.sol";
import "./IStabilityPool.sol";
import "./ILUSDToken.sol";
import "./ILQTYToken.sol";
import "./ILQTYStaking.sol";
import "./IRelayer.sol";


// Common interface for the Liquidations
interface ILiquidations is ILiquityBase {
    
    // --- Events ---

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event RewardsAddressChanged(address _newRewardsAddress);
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
    event RelayerAddressChanged(address _relayerAddress);

    event Liquidation(uint _liquidatedDebt, uint _liquidatedColl, uint _collGasCompensation, uint _LUSDGasCompensation);
    event Redemption(uint _attemptedLUSDAmount, uint _actualLUSDAmount, uint _ETHSent, uint _ETHFee);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, uint8 operation);
    event TroveLiquidated(address indexed _borrower, uint _debt, uint _coll, uint8 operation);
    event BaseRateUpdated(uint _baseRate);
    event LastFeeOpTimeUpdated(uint _lastFeeOpTime);
    event TotalStakesUpdated(uint _newTotalStakes);
    event SystemSnapshotsUpdated(uint _totalStakesSnapshot, uint _totalCollateralSnapshot);
    event LTermsUpdated(uint _L_ETH, uint _L_LUSDDebt);
    event TroveSnapshotsUpdated(uint _L_ETH, uint _L_LUSDDebt);
    event TroveIndexUpdated(address _borrower, uint _newIndex);

    event AccInterestRateUpdated(uint256 rate);

    // --- Functions ---

    function setAddresses(
        address _troveManagerAddress,
        address _rewardsAddress,
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
        address _relayerAddress
    ) external;

    function stabilityPool() external view returns (IStabilityPool);
    function lusdToken() external view returns (ILUSDToken);

    function liquidate(address _borrower) external;

    function liquidateTroves(uint _n) external;

    function batchLiquidate(address[] calldata _troveArray) external;

}
