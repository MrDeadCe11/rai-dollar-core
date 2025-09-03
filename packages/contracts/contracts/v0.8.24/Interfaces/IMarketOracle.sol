// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface IMarketOracle {
    // --- Events ---
    event LastGoodPriceUpdated(uint256 lastGoodPrice);

    // --- Function ---
    function price() external view returns (uint256);

    function rdLiquidity() external view returns (uint256);

    function setPrice(int256 newPrice) external returns (int256);

}
