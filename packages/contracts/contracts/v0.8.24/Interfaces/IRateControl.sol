pragma solidity 0.8.24;

interface IRateControl {
    function setAddresses(address _relayerAddress) external;
    function boundAndClampPiOutput(int256 piOutput, int256 errorIntegral, int256 newArea, uint256 timeElapsed) external view returns (int256, int256);
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
    function rpower(uint256 x, uint256 n, uint256 base) external pure returns (uint256 z);
    function update(int256 error) external returns (int256, int256, int256);
}
