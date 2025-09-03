// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MarketOracleTestnet {

    int256 public price = 1e18;
    uint public rdLiquidity = 1e6;

    function setRDLiquidity(uint _liquidity) external returns (uint) {
        rdLiquidity = _liquidity;
    }

    function setPrice(int256 newPrice) external {
        price = newPrice;
    }

}
