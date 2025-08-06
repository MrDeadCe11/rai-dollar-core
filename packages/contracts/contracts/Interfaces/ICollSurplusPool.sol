// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;


interface ICollSurplusPool {

    // --- Events ---
    
    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event LiquidationsAddressChanged(address _newLiquidationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);

    event CollBalanceUpdated(address indexed _account, uint _newBalance);
    event CollateralSent(address _to, uint _amount);

    // --- Contract setters ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _liquidationsAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _collateralTokenAddress
    ) external;

    function getCollateral() external view returns (uint256);

    function getCollateral(address _account) external view returns (uint256);

    function addCollateral(address _account, uint _amount) external;

    function addCollateral(address _account, uint _amount) external;

    function accountSurplus(address _account, uint _amount) external;

    function claimColl(address _account) external returns (uint256);

    function processCollateralIncrease(uint _amount) external;
}
