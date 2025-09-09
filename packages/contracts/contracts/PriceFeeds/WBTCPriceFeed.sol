// SPDX-License-Identifier: MIT

pragma solidity 0.8.24;
 
import "./CompositePriceFeed.sol";


contract WBTCPriceFeed is CompositePriceFeed {
    Oracle public btcUsdOracle;
    Oracle public wbtcBtc;

    uint256 public constant WBTC_BTC_DEVIATION_THRESHOLD = 2e16; // 2%
    
    constructor( 
        address _wbtcBtcAddress, 
        address _btcUsdOracleAddress,
        uint256 _wbtcUsdStalenessThreshold,
        uint256 _btcUsdStalenessThreshold,
        address _borrowerOperationsAddress
    ) CompositePriceFeed(_wbtcBtcAddress, _btcUsdOracleAddress, _wbtcUsdStalenessThreshold, _borrowerOperationsAddress)
    {
        // Store BTC-USD oracle
        btcUsdOracle.aggregator = AggregatorV3Interface(_btcUsdOracleAddress);
        btcUsdOracle.stalenessThreshold = _btcUsdStalenessThreshold;
        btcUsdOracle.decimals = btcUsdOracle.aggregator.decimals();

        // Store wBTC-USD oracle
        wbtcBtc.aggregator = AggregatorV3Interface(_wbtcBtcAddress);
        wbtcBtc.stalenessThreshold = _wbtcUsdStalenessThreshold;
        wbtcBtc.decimals = wbtcBtc.aggregator.decimals();

        _fetchPricePrimary(false);

        // Check the oracle didn't already fail
        assert(priceSource == PriceSource.primary);
    }

    function _fetchPricePrimary(bool _isRedemption) internal override returns (uint256, bool) {
        assert(priceSource == PriceSource.primary);
        (uint256 wbtcBtcPrice, bool wbtcBtcDown) = _getOracleAnswer(wbtcBtc);
        (uint256 btcUsdPrice, bool btcOracleDown) = _getOracleAnswer(btcUsdOracle);
        
        uint256 wbtcUsdMarketRate = wbtcBtcPrice * btcUsdPrice / 1e18;
        
        // tBTC oracle is down or invalid answer
        if (wbtcBtcDown) {
            return (_shutDownAndSwitchToLastGoodPrice(address(wbtcBtc.aggregator)), true);
        }

        // BTC oracle is down or invalid answer
        if (btcOracleDown) {
            return (_shutDownAndSwitchToLastGoodPrice(address(btcUsdOracle.aggregator)), true);
        }

        // Otherwise, use the primary price calculation:
        if (_isRedemption && _withinDeviationThreshold(wbtcUsdMarketRate, btcUsdPrice, WBTC_BTC_DEVIATION_THRESHOLD)) {
            // If it's a redemption and within 2%, take the max of (wBTC-USD, BTC-USD) to prevent value leakage and convert to wBTC-USD
            wbtcUsdMarketRate = LiquityMath._max(wbtcUsdMarketRate, btcUsdPrice);
        }else{
            // Take the minimum of (market, canonical) in order to mitigate against upward market price manipulation.
            wbtcUsdMarketRate = LiquityMath._min(wbtcUsdMarketRate, btcUsdPrice);
        }

        // Otherwise, just use wBTC-USD price: USD_per_wBTC.
        lastGoodPrice = wbtcUsdMarketRate;
        return (wbtcUsdMarketRate, false);
    }

    function _getCanonicalRate() internal view override returns (uint256, bool) {
        return (1 * 10 ** 18, false); // always return 1 BTC per wBTC by default.
    }
}   


