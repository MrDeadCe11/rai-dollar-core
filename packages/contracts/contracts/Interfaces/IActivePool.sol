// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IPool.sol";
import "../Dependencies/IERC20.sol";


interface IActivePool is IPool {
    // --- Events ---
    event LiquidationsAddressChanged(address _newLiquidationsAddress);
    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolLUSDDebtUpdated(uint _LUSDDebt);
    event ActivePoolETHBalanceUpdated(uint _ETH);

    // --- Functions ---
    function collateralToken() external view returns (IERC20);
    function sendCollateral(address _account, uint _amount) external;
}
