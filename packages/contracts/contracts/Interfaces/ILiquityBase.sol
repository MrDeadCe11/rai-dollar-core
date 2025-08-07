// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IPriceFeed.sol";
import "./IActivePool.sol";

interface ILiquityBase {
    function activePool() external view returns (IActivePool);
    function priceFeed() external view returns (IPriceFeed);
}
