// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../FeeRouter.sol";

contract FeeRouterTester is FeeRouter {
    function getCurrentValue() external view returns (uint) {
        return _getCurrentValue();  
    }

    function updateAllocation() external {
        return _updateAllocation();
    }

}
