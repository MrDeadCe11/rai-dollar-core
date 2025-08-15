// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/IERC20.sol";
import "../Interfaces/ILiquityBase.sol";
import "../Dependencies/IERC20.sol";

// Common interface for the Trove Manager.
interface IBorrowerOperations is ILiquityBase {

    // --- Events ---

    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event RewardsAddressChanged(address _newRewardsAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event ActiveShieldedPoolAddressChanged(address _activeShieldedPoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event DefaultShieldedPoolAddressChanged(address _defaultShieldedPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event GasPoolAddressChanged(address _gasPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address  _newPriceFeedAddress);
    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event LUSDTokenAddressChanged(address _lusdTokenAddress);
    event LQTYStakingAddressChanged(address _lqtyStakingAddress);
    event RelayerAddressChanged(address _relayerAddress);
    event CollateralTokenAddressChanged(address _collateralTokenAddress);

    event TroveCreated(address indexed _borrower, uint arrayIndex);
    event ShieldedTroveCreated(address indexed _borrower, uint arrayIndex);
    event TroveUpdated(address indexed _borrower, uint _debt, uint _coll, uint stake, uint8 operation);
    event LUSDBorrowingFeePaid(address indexed _borrower, uint _LUSDFee);

    // --- Functions ---

   function setAddresses(address[] memory addresses) external;

    function collateralToken() external view returns (IERC20);

    function openTrove(uint256 _collateralToAdd, uint _LUSDAmount, address _upperHint, address _lowerHint, bool _redemptionShield) external;

    function shieldTrove(address _upperHint, address _lowerHint) external;

    function unShieldTrove(address _upperHint, address _lowerHint) external;

    function addColl(uint256 _collateralToAdd, address _upperHint, address _lowerHint) external;

    function moveCollateralGainToTrove(address _user, uint256 _collateralToAdd, address _upperHint, address _lowerHint) external;

    function withdrawColl(uint _amount, address _upperHint, address _lowerHint) external;

    function withdrawLUSD(uint _amount, address _upperHint, address _lowerHint) external;

    function repayLUSD(uint _amount, address _upperHint, address _lowerHint) external;

    function closeTrove() external;

    function adjustTrove(uint256 _collateralToAdd, uint _collWithdrawal, uint _debtChange, bool _isDebtIncrease, bool _toggleShield, address _upperHint, address _lowerHint) external;

    function claimCollateral() external returns (uint256);

    function getCompositeDebt(uint _debt) external pure returns (uint);
}
