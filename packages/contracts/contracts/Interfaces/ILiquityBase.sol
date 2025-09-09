// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import {IPriceFeedV2} from "./IPriceFeed.sol";
import "./IActivePool.sol";

interface ILiquityBase {
    function activePool() external view returns (IActivePool);
    function priceFeed() external view returns (IPriceFeedV2);

    function getEntireSystemDebt(uint accumulatedRate, uint accumulatedShieldRate) external view returns (uint);

}
