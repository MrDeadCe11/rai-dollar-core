// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "./IRelayer.sol";

interface IParControl {
    function setAddresses(address _relayerAddress) external;
    function boundPiOutput(int256 piOutput) external view returns (int256);
    function CO_BIAS() external view returns (int256);
    function controlVariable() external view returns (bytes32);
    function elapsed() external view returns (uint256);
    function errorIntegral() external view returns (int256);
    function getNextErrorIntegral(int256 error, uint256 timeElapsed) external view returns (int256, int256);
    function getNextPiOutput(int256 error, uint256 timeElapsed) external view returns (int256, int256, int256, int256);
    function getNextPiOutput(int256 error) external view returns (int256, int256, int256, int256);
    function getRawPiOutput(int256 error, int256 errorI) external view returns (int256, int256);
    function KI() external view returns (int256);
    function KP() external view returns (int256);
    function lastError() external view returns (int256);
    function lastUpdateTime() external view returns (uint256);
    function OUTPUT_LOWER_BOUND() external view returns (int256);
    function OUTPUT_UPPER_BOUND() external view returns (int256);
    function PER_SECOND_INTEGRAL_LEAK() external view returns (uint256);
    function riemannSum(int256 x, int256 y) external pure returns (int256 z);
    function rpower(uint256 x, uint256 n, uint256 base) external pure returns (uint256 z);
    function update(int256 error) external returns (int256, int256, int256);
    function relayer() external view returns (IRelayer);
}
