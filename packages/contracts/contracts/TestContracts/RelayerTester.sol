// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../Relayer.sol";

/* Tester contract inherits from Relayer, and provides external functions 
for testing the parent's internal functions. */

contract RelayerTester is Relayer {
    function parControlError(uint256 market) external pure returns (int256) {
        return _parControlError(market);
    }

    function rateControlError(uint256 market) external pure returns (int256) {
        return _rateControlError(market);
    }

    function rampErrorDec(
        int256 error,
        uint256 eps_1,
        uint256 eps_2
    ) external pure returns (int256) {
        return _rampErrorDec(error, eps_1, eps_2);
    }
    function rampErrorRay(
        int256 error,
        uint256 eps_1,
        uint256 eps_2
    ) external pure returns (int256) {
        return _rampErrorRay(error, eps_1, eps_2);
    }
}
