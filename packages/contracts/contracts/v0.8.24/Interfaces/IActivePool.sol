// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "./IPool.sol";
import "../Dependencies/IERC20.sol";


interface IActivePool is IPool {
    // --- Events ---
    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolLUSDDebtUpdated(uint _LUSDDebt);
    event ActivePoolCollateralBalanceUpdated(uint _collateral);

    // --- Functions ---
    function collateralToken() external view returns (IERC20);
    function sendCollateral(address _account, uint _amount) external;
}
