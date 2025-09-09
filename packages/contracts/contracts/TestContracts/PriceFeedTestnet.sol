// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IPriceFeed.sol";
import {IPriceFeedV2} from "../Interfaces/IPriceFeed.sol";

/*
* PriceFeed placeholder for testnet and development. The price is simply set manually and saved in a state 
* variable. The contract does not connect to a live Chainlink price feed. 
*/
contract PriceFeedTestnet is IPriceFeed {
    
    uint256 private _price = 200 * 1e18;

    // --- Functions ---

    // View price getter for simplicity in tests
    function getPrice() external view returns (uint256) {
        return _price;
    }

    function fetchPrice() external override returns (uint256) {
        // Fire an event just like the mainnet version would.
        // This lets the subgraph rely on events to get the latest price even when developing locally.
        emit LastGoodPriceUpdated(_price);
        return _price;
    }

    // Manual external price setter.
    function setPrice(uint256 price) external returns (bool) {
        _price = price;
        return true;
    }
}

contract PriceFeedTestnetV2 is IPriceFeedV2 {
    bool public oracleFailure;
    uint256 public _price = 200 * 1e18;

    function fetchPrice() external override returns (uint256, bool) {
        emit LastGoodPriceUpdated(_price);
        return (_price, oracleFailure);
    }

        // Manual external price setter.
    function setPrice(uint256 price) external returns (bool) {
        _price = price;
        return true;
    }

       // View price getter for simplicity in tests
    function getPrice() external view returns (uint256) {
        return _price;
    }

    function setOracleFailure(bool _oracleFailure) external {
        oracleFailure = _oracleFailure;
    }
}
