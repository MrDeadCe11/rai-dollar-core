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

// Common interface for the Trove Manager.
interface IFeeRouter {
    
    // --- Events ---

    event TroveManagerAddressChanged(address _troveManagerAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event RDTokenAddressChanged(address _rdTokenAddress);
    event GlobalFeeRouterAddressChanged(address _globalFeeRouterAddress);
    event FeesAllocated(uint toSP, uint remaining, uint ema, int integral, uint allocFrac);

    // --- Functions ---

    function setAddresses(address _troveManagerAddress, address _stabilityPoolAddress, address _rdTokenAddress, address _globalFeeRouterAddress) external;

    function previewNextAlloc(uint _currentUtil) external returns (uint, int);
    function allocateFees(uint _totalFees) external;

}
