// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./ILiquityBase.sol";
import "./IStabilityPool.sol";
import "./ILUSDToken.sol";
import "./ILQTYToken.sol";
import "./ILQTYStaking.sol";
import "./IRelayer.sol";


// Common interface for the Trove Manager.
interface IAggregator is ILiquityBase {
    
    // --- Events ---

    event TroveManagerAddressChanged(address _newBorrowerOperationsAddress);
    event LUSDTokenAddressChanged(address _newLUSDTokenAddress);

    event BaseRateUpdated(uint _baseRate);
    event LastFeeOpTimeUpdated(uint _lastFeeOpTime);

    // --- Functions ---

    function setAddresses(
        address _troveManagerAddress,
        address _lusdTokenAddress
    ) external;

    function baseRate() external view returns (uint);

    function lastFeeOperationTime() external view returns (uint);

    //function setBaseRate(uint rate) external returns (uint);

    function lusdToken() external view returns (ILUSDToken);

    function updateBaseRateFromRedemption(uint, uint, uint, uint) external returns (uint);

    function getRedemptionRate() external view returns (uint);
    function getRedemptionRateWithDecay() external view returns (uint);

    function calcBaseRateForRedemption(uint _LUSDAmount, uint _baseRate, uint _price, uint _par, uint _totalLUSDSupply) external pure returns (uint);
    function calcRedemptionAmount(uint _LUSDAmount, uint _price, uint _par) external pure returns (uint);
    function calcNewBaseRate(uint _ETHDrawn, uint _baseRate, uint _price, uint _par, uint _totalLUSDSupply) external pure returns (uint);

    function getRedemptionFee(uint _ETHDrawn) external view returns (uint);
    function getRedemptionFeeWithDecay(uint _ETHDrawn) external view returns (uint);

    function calcRedemptionFee(uint _redemptionRate, uint _ETHDrawn) external view returns (uint);

}
