// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MarketOracleTestnet {

    int256 public price = 1e18;

    function setPrice(int256 newPrice) external {
        price = newPrice;
    }
}
