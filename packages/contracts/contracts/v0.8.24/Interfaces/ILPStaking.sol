// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;

interface ILPStaking {

    // --- Events --
    
    function stake(uint _amount) external;
    function unstake(uint _amount) external;

}
