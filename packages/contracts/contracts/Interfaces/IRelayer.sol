// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

interface IRelayer {
    // Events
    event ParUpdated(int256 par, int256 pOutput, int256 iOutput, int256 error);
    event RateUpdated(int256 rate, int256 pOutput, int256 iOutput, int256 error);

    // External functions
    function setAddresses(
        address parControlAddress,
        address rateControlAddress,
        address marketOracleAddress,
        address troveManagerAddress,
        address borrowerOperationsAddress
    ) external;

    function parControlError(uint256 market) external pure returns (int256);
    function rateControlError(uint256 market) external pure returns (int256);

    function getPar() external returns (uint256);
    function getRate() external returns (uint256);
    function getRateAndPar() external returns (uint256, uint256);

    function nextRateAndPar() external view returns (uint256, uint256);

    function updateRateAndPar() external returns (uint256, uint256);
    function updatePar() external returns (uint256);
    function updateRate() external returns (uint256);

    function updateParWithMarket(uint256 marketPrice) external returns (uint256);
    function updateRateWithMarket(uint256 marketPrice) external returns (uint256);
    function updateParAndRateWithMarket(uint256 marketPrice) external returns (uint256, uint256);

    function par() external view returns (uint256);
    function rate() external view returns (uint256);

    function MAX_PAR_STALENESS() external view returns (uint256);
    function MAX_RATE_STALENESS() external view returns (uint256);
}
