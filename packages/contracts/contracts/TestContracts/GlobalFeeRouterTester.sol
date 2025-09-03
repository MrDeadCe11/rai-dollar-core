// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

import "../GlobalFeeRouter.sol";

contract GlobalFeeRouterTester is GlobalFeeRouter {
    /*
    function controller(int _error, int _kp, int _ki, int _integral, uint _dt, int _bias) external pure returns (uint, int) {
        return _controller(_error, _kp, _ki, _integral, _dt, _bias);
    }
    */
    function getCurrentValue() external view returns (uint) {
        return _getCurrentValue();  
    }

    /*
    function calcDecay(uint _dt) external view returns (uint) {
        return _calcDecay(_dt);
    }

    function updateEma(uint256 _currentValue) external {
        ema =  _updateEma(_currentValue);
    }
    */

    function updateAllocation(bool capReached) external {
        return _updateAllocation(capReached);
    }

    /*
    function decayFactor(uint _idx) external view returns (uint) {
        return _decayFactor(_idx);
    }
    */

    function splitOracleAndRemaining(uint _amount) external view returns (uint, uint) {
        return _splitOracleAndRemaining(_amount);
    }
}
