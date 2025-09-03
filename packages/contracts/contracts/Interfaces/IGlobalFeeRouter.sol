// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ILiquityBase.sol";
import "./IStabilityPool.sol";
import "./IActivePool.sol";
import "./IDefaultPool.sol";
import "./ILUSDToken.sol";
import "./ILQTYToken.sol";
import "./ILQTYStaking.sol";
import "./IRelayer.sol";
import "./ICollSurplusPool.sol";

interface IGlobalFeeRouter {
    
    // --- Events ---

    event TroveManagerAddressChanged(address _troveManagerAddress);
    event AggregatorAddressChanged(address _aggregatorAddress);
    event LpStakingAddressChanged(address _lpStakingAddress);
    event LQTYStakingAddressChanged(address _lqtyStakingAddress);
    event RDTokenAddressChanged(address _rdTokenAddress);
    event GlobalFeeRouterAddressChanged(address _globalFeeRouterAddress);
    event GlobalDrip(uint _toLP, uint _toStakers, uint _toOracle, uint _ema, int _integral, uint _LpAllocFrac);


    // --- Functions ---

    function setAddresses(address _aggregatorAddress,
                          address _lpStakingAddress,
                          address _lqtyStakingAddress,
                          address _marketOracleAddress,
                          address _rdTokenAddress) external;

    function previewNextAlloc(uint _currentUtil) external returns (uint, int);
    function allocateFees(uint _totalFees, uint _remaining) external;
    function pendingLpDistribution() external returns (uint);
    function pendingStakerDistribution() external returns (uint);
    function pendingFees() external returns (uint);

}
