// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IPool.sol";
import "./IActivePool.sol";


interface IDefaultPool is IPool {
    // --- Events ---
    event LiquidationsAddressChanged(address _newLiquidationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event DefaultPoolLUSDDebtUpdated(uint _LUSDDebt);
    event DefaultPoolCollateralBalanceUpdated(uint _COLLATERAL);

    // --- Functions ---
    function sendCollateralToActivePool(IActivePool _activePool, uint _amount) external;
}
