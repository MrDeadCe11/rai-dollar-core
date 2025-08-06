const { chainlinkOracles, tokens } = require('../mainnetAddresses.js');
const AggregatorV3InterfaceArtifact = require('../artifacts/contracts/v0.8.24/Dependencies/AggregatorV3Interface.sol/AggregatorV3Interface.json');
const MockChainlinkAggregatorArtifact = require('../artifacts/contracts/v0.8.24/TestContracts/MockChainlinkAggregator.sol/MockChainlinkAggregator.json');
const MockWSTETHArtifact = require('../artifacts/contracts/v0.8.24/TestContracts/MockWSTETH.sol/MockWSTETH.json');
const MockRETHArtifact = require('../artifacts/contracts/v0.8.24/TestContracts/MockRETH.sol/MockRETH.json');
const { TestHelper, TimeValues } = require("../utils/testHelpers.js")
const th = TestHelper
const { BigNumber } = require("ethers");
const { dec, assertRevert, toBN } = th
const { secrets } = require('../secrets.js');
const ALCHEMY_API_KEY = secrets.alchemyAPIKey;
console.log("ALCHEMY_API_KEY", ALCHEMY_API_KEY);
const hre = require("hardhat");
// test with:
// source .env && anvil --fork-url https://eth-mainnet.g.alchemy.com/v2/ALCHEMY_API_KEY --chain-id 31337
// yarn workspace @liquity/contracts hardhat test test/MainnetPriceFeedTest.js --network anvil


function getEvent(receipt, eventName) {
    const event = receipt.events.find(log => log.event === eventName);
    return event;
}

contract('PriceFeedMainnetForkTest', async accounts => {

    // staleness threshold for the price feeds
    const stalenessThreshold = TimeValues.SECONDS_IN_ONE_DAY;  // 24hr staleness

    let chainlinkEthUsdOracle;
    let chainlinkStEthUsdOracle;
    let chainlinkRethEthOracle;
    let wstEthPriceFeed;
    let rethPriceFeed;
    let block;

    function calculateRethPrice(ethUsdPrice, rEthEthPrice, canonicalRate, isRedemption) {
        // scale up ethUsdPrice and rEthEthPrice by 10 digits
        const ethUsdPriceWith10Digits = ethUsdPrice.mul(BigNumber.from(dec(1,10)));

        // Constants
        const DECIMAL_PRECISION = BigNumber.from(dec(1, 18));
        const RETH_ETH_DEVIATION_THRESHOLD = BigNumber.from(dec(2, 16)); // 2%
        
        // Calculate the market RETH-USD price: USD_per_RETH = USD_per_ETH * ETH_per_RETH
        const rEthUsdMarketPrice = ethUsdPriceWith10Digits.mul(rEthEthPrice).div(DECIMAL_PRECISION);
        
        // Calculate the canonical LST-USD price: USD_per_RETH = USD_per_ETH * ETH_per_RETH
        const rEthUsdCanonicalPrice = ethUsdPriceWith10Digits.mul(canonicalRate).div(DECIMAL_PRECISION);
        
        let rEthUsdPrice;
        
        // Check if prices are within deviation threshold (2%)
        function withinDeviationThreshold(priceToCheck, referencePrice, deviationThreshold) {
            const max = referencePrice.mul(DECIMAL_PRECISION.add(deviationThreshold)).div(DECIMAL_PRECISION);
            const min = referencePrice.mul(DECIMAL_PRECISION.sub(deviationThreshold)).div(DECIMAL_PRECISION);
            return priceToCheck.gte(min) && priceToCheck.lte(max);
        }
        
        // If it's a redemption and canonical is within 2% of market, use the max to mitigate unwanted redemption oracle arb
        if (isRedemption && withinDeviationThreshold(rEthUsdMarketPrice, rEthUsdCanonicalPrice, RETH_ETH_DEVIATION_THRESHOLD)) {
            rEthUsdPrice = rEthUsdMarketPrice.gt(rEthUsdCanonicalPrice) ? rEthUsdMarketPrice : rEthUsdCanonicalPrice;
        } else {
            // Take the minimum of (market, canonical) in order to mitigate against upward market price manipulation.
            // Assumes a deviation between market <> canonical of >2% represents a legitimate market price difference.
            rEthUsdPrice = rEthUsdMarketPrice.lt(rEthUsdCanonicalPrice) ? rEthUsdMarketPrice : rEthUsdCanonicalPrice;
        }
        
        return rEthUsdPrice;
    }

    function calculateRate(tokenUsdPrice, lstRate) {
        // scale up tokenUsdPrice by 10 digits
        const tokenUsdPriceWith10Digits = tokenUsdPrice.mul(BigNumber.from(dec(1,10)));
        const lstUsdCanonicalPrice = tokenUsdPriceWith10Digits.mul(lstRate).div(BigNumber.from(dec(1,18)));
        return lstUsdCanonicalPrice;
    }

    async function etchContract(address, artifact) {
        await network.provider.send("hardhat_setCode", [address, artifact.deployedBytecode]);
        const mockedContract = await ethers.getContractAt(artifact.abi, address);
        return mockedContract;
    }

    describe.skip("WSTETHPriceFeed", () => {
        beforeEach(async () => {
        // Reset fork state before each test
        await hre.network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.MAINNET_RPC_URL || `https://eth-mainnet.alchemyapi.io/v2/${ALCHEMY_API_KEY}`,
                        blockNumber: 22894418,
                    },
                },
            ],
        });
           
        block = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
        const deployerWallet = (await ethers.getSigners())[0];

        chainlinkEthUsdOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.ethUsd, deployerWallet);
        chainlinkStEthUsdOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.stEthUsd, deployerWallet);

        wstEth = await ethers.getContractAt("IWSTETH", tokens.wsteth, deployerWallet);

        
        const WSTETHPriceFeedFactory = await ethers.getContractFactory("WSTETHPriceFeed", deployerWallet);

        // deploy price feeds
        wstEthPriceFeed = await WSTETHPriceFeedFactory.deploy(
            chainlinkOracles.ethUsd,
            chainlinkOracles.stEthUsd,
            tokens.wsteth,
            stalenessThreshold,
            stalenessThreshold
        )
        });
        async function getPrice(oracle) {
            const price = await oracle.latestRoundData();
            return price.answer;
        }
        it("WstethPriceFeed: lastGoodPrice should be set on deployment", async () => {
            const price = await wstEthPriceFeed.lastGoodPrice();
            expect(price.gt(BigNumber.from(dec(0,18)))).to.be.true;
            expect(price.lt(BigNumber.from(dec(5,21)))).to.be.true;
        });

        it("WstethPriceFeed: should get the price of wsteth in usd", async () => {
            await wstEthPriceFeed.fetchPrice();
            const price = await wstEthPriceFeed.lastGoodPrice();
            const stEthUsdPrice = (await chainlinkStEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await wstEth.stEthPerToken(); 
            const canonicalPrice = calculateRate(stEthUsdPrice, canonicalRate);
            expect(price.eq(canonicalPrice)).to.be.true;
        });
        
        it("WstethPriceFeed: should use eth/usd x canonical rate if steth/usd oracle is stale", async () => {
            // etch chainlink wsteth oracle with mock chainlink aggregator
            chainlinkStEthUsdOracle = await etchContract(chainlinkOracles.stEthUsd, MockChainlinkAggregatorArtifact);
            await chainlinkStEthUsdOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            await wstEthPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await wstEthPriceFeed.priceSource();
            const lastGoodPrice = await wstEthPriceFeed.lastGoodPrice();

            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await wstEth.stEthPerToken();

            const calculatedPrice = calculateRate(ethUsdPrice, canonicalRate);
            const expectedPrice = calculatedPrice.gt(lastGoodPrice) ? calculatedPrice : lastGoodPrice;

            expect(lastGoodPrice.eq(expectedPrice)).to.be.true;
            expect(priceSource).to.equal(1);
        });

        it("WstethPriceFeed: should use eth/usd x canonical rate if steth/usd oracle returns 0 price", async () => {
            chainlinkStEthUsdOracle = await etchContract(chainlinkOracles.stEthUsd, MockChainlinkAggregatorArtifact);
            await chainlinkStEthUsdOracle.setPrice(hre.ethers.utils.parseUnits("0", 8));
            await chainlinkStEthUsdOracle.setUpdateTime(block.timestamp);
            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            await wstEthPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await wstEthPriceFeed.priceSource();
            const lastGoodPrice = await wstEthPriceFeed.lastGoodPrice();

            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await wstEth.stEthPerToken();
            const calculatedPrice = calculateRate(ethUsdPrice, canonicalRate);
            const expectedPrice = calculatedPrice.gt(lastGoodPrice) ? calculatedPrice : lastGoodPrice;

            expect(lastGoodPrice.eq(expectedPrice)).to.be.true;
            expect(priceSource).to.equal(1);
        });

        it("WstethPriceFeed: should have correct stored staleness for chainlink steth/usd oracle", async () => {
            const oracle = await wstEthPriceFeed.stEthUsdOracle();
            expect(oracle.stalenessThreshold.eq(BigNumber.from(TimeValues.SECONDS_IN_ONE_DAY))).to.be.true;
        });

        it("WstethPriceFeed: should have correct stored staleness for chainlink eth/usd oracle", async () => {
            const oracle = await wstEthPriceFeed.ethUsdOracle();
            expect(oracle.stalenessThreshold.eq(BigNumber.from(stalenessThreshold))).to.be.true;
        });



        it("WstethPriceFeed: price source should be lastGoodPrice and should return lastGoodPrice when canonicalexchange rate fails", async () => {
            await wstEthPriceFeed.fetchPrice();
            const lastGoodPrice = await wstEthPriceFeed.lastGoodPrice();
            wstEth = await etchContract(tokens.wsteth, MockWSTETHArtifact);

            const tx = await wstEthPriceFeed.fetchPrice();
            const receipt = await tx.wait();
            const event = getEvent(receipt, "ShutDownFromOracleFailure");

            const priceSource = await wstEthPriceFeed.priceSource();
            const priceAfterFailure = await wstEthPriceFeed.lastGoodPrice();

            expect(priceSource).to.equal(2);
            expect(event).to.exist;
            expect(lastGoodPrice.eq(priceAfterFailure)).to.be.true;
        });

        it("WstethPriceFeed: price source should be lastGoodPrice and should return lastGoodPrice when Eth/USD oracle isStale", async () => {
            await wstEthPriceFeed.fetchPrice();
            const price1 = await wstEthPriceFeed.lastGoodPrice();
            const priceSource1 = await wstEthPriceFeed.priceSource();
            expect(price1.gt(BigNumber.from(0))).to.be.true;
            expect(priceSource1).to.equal(0);

            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            const staleTime = block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1);
            await chainlinkEthUsdOracle.setUpdateTime(staleTime);
            const roundData = await chainlinkEthUsdOracle.latestRoundData();
            expect(roundData.updatedAt.eq(BigNumber.from(staleTime))).to.be.true;

            await wstEthPriceFeed.fetchPrice();
            const price2 = await wstEthPriceFeed.lastGoodPrice();
            const priceSource2 = await wstEthPriceFeed.priceSource();
            expect(price2.eq(price1)).to.be.true;
            expect(priceSource2).to.equal(2);
        });

        it("WstethPriceFeed: price source should be lastGoodPrice and should return lastGoodPrice when Eth/USD oracle returns 0 price", async () => {
            await wstEthPriceFeed.fetchPrice();
            const price1 = await wstEthPriceFeed.lastGoodPrice();
            const priceSource1 = await wstEthPriceFeed.priceSource();
            expect(price1.gt(BigNumber.from(0))).to.be.true;
            expect(priceSource1).to.equal(0);

            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            await chainlinkEthUsdOracle.setPrice(hre.ethers.utils.parseUnits("0", 8));
            await chainlinkEthUsdOracle.setUpdateTime(block.timestamp);
            const roundData = await chainlinkEthUsdOracle.latestRoundData();
            expect(roundData.answer.eq(BigNumber.from(0))).to.be.true;

            await wstEthPriceFeed.fetchPrice();
            const price2 = await wstEthPriceFeed.lastGoodPrice();
            const priceSource2 = await wstEthPriceFeed.priceSource();
            expect(price2.eq(price1)).to.be.true;
            expect(priceSource2).to.equal(2);
        });

        it("WstethPriceFeed: fetch price should return min ETHUSD x canonical rate or lastGoodPrice when Steth/usd oracle is stale and price source should be ETHUSDXCanonicalRate", async () => {
            await wstEthPriceFeed.fetchPrice();
            const priceBeforeFailure = await wstEthPriceFeed.lastGoodPrice();
            const priceSourceBeforeFailure = await wstEthPriceFeed.priceSource();
            expect(priceBeforeFailure.gt(BigNumber.from(0))).to.be.true;
            expect(priceSourceBeforeFailure).to.be.equal(0);


            chainlinkStEthUsdOracle = await etchContract(chainlinkOracles.stEthUsd, MockChainlinkAggregatorArtifact);
            const staleTime = block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1);
            await chainlinkStEthUsdOracle.setUpdateTime(staleTime);
            const roundData = await chainlinkStEthUsdOracle.latestRoundData();
            expect(roundData.updatedAt.eq(BigNumber.from(staleTime))).to.be.true;

            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            const tx = await wstEthPriceFeed.fetchPrice({ gasLimit: 2000000 });
            const receipt = await tx.wait();
           
            // assert that oracle did fail
            const event = getEvent(receipt, "ShutDownFromOracleFailure");
            expect(event).to.exist;
            expect(event.args._failedOracleAddr).to.equal(chainlinkOracles.stEthUsd);
            const priceSourceAfterFailure = await wstEthPriceFeed.priceSource();

            expect(priceSourceAfterFailure).to.equal(1);

            const lastGoodAfterFailure = await wstEthPriceFeed.lastGoodPrice();

            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await wstEth.stEthPerToken();
            const calculatedPrice = calculateRate(ethUsdPrice, canonicalRate);

            const expectedPrice = calculatedPrice.lt(lastGoodAfterFailure) ? calculatedPrice : lastGoodAfterFailure;

            expect(lastGoodAfterFailure.eq(expectedPrice)).to.be.true;
        });

        it("WstethPriceFeed: When Using ETHUSDxCanonical, it remains shut down when ETHUSDOracle fails", async () => {
            await wstEthPriceFeed.fetchPrice();
            const priceBeforeFailure = await wstEthPriceFeed.lastGoodPrice();
            const priceSourceBeforeFailure = await wstEthPriceFeed.priceSource();
            expect(priceSourceBeforeFailure).to.be.equal(0);

            chainlinkStEthUsdOracle = await etchContract(chainlinkOracles.stEthUsd, MockChainlinkAggregatorArtifact);
            await chainlinkStEthUsdOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            const tx = await wstEthPriceFeed.fetchPrice({ gasLimit: 2000000 });
            const receipt = await tx.wait();

            // assert that oracle did fail
            const event = getEvent(receipt, "ShutDownFromOracleFailure");
            expect(event).to.exist;
            expect(event.args._failedOracleAddr).to.equal(chainlinkOracles.stEthUsd);

            const priceSourceAfterStethFailure = await wstEthPriceFeed.priceSource();
            expect(priceSourceAfterStethFailure).to.be.equal(1);

            // mock eth/usd oracle
            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            await chainlinkEthUsdOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            await wstEthPriceFeed.fetchPrice();

            const priceSourceAfterEthUsdFailure = await wstEthPriceFeed.priceSource();
            expect(priceSourceAfterEthUsdFailure).to.be.equal(2);
        });
    });

    describe.skip("RETHPriceFeed", () => {
        beforeEach(async () => {
        // Reset fork state before each test
        await hre.network.provider.request({
            method: "hardhat_reset",
            params: [
                {
                    forking: {
                        jsonRpcUrl: process.env.MAINNET_RPC_URL || `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
                        // Optional: pin to specific block for consistency
                        blockNumber: 22894418,
                    },
                },
            ],
        });
           
        block = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
        const deployerWallet = (await ethers.getSigners())[0];

        chainlinkEthUsdOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.ethUsd, deployerWallet);
        chainlinkRethEthOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.rsEthEth, deployerWallet);

        reth = await ethers.getContractAt("IRETHToken", tokens.reth, deployerWallet);

        
        const RETHPriceFeedFactory = await ethers.getContractFactory("RETHPriceFeed", deployerWallet);

        // deploy price feeds
        rethPriceFeed = await RETHPriceFeedFactory.deploy(
            chainlinkOracles.ethUsd,
            chainlinkOracles.rsEthEth,
            tokens.reth,
            stalenessThreshold,
            stalenessThreshold
        )
        });

        it("RETHPriceFeed: lastGoodPrice should be set on deployment", async () => {
            const price = await rethPriceFeed.lastGoodPrice();
            expect(price.gt(BigNumber.from(dec(0,18)))).to.be.true;
            expect(price.lt(BigNumber.from(dec(5,21)))).to.be.true;
        });

        it("RETHPriceFeed: should get the price of reth in usd", async () => {
            await rethPriceFeed.fetchPrice();
            const price = await rethPriceFeed.lastGoodPrice();
            const rEthEthPrice = (await chainlinkRethEthOracle.latestRoundData()).answer;
            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await reth.getExchangeRate(); 
            const canonicalPrice = calculateRethPrice(ethUsdPrice, rEthEthPrice, canonicalRate, false);
            const priceSource = await rethPriceFeed.priceSource();
            expect(price.eq(canonicalPrice)).to.be.true;
            expect(priceSource).to.equal(0);
        });
        
        it("RETHPriceFeed: should use min(eth/usd x canonical rate, lastgoodprice) if reth/eth oracle is stale", async () => {
            // etch chainlink reth/eth oracle with mock chainlink aggregator
            chainlinkRethEthOracle = await etchContract(chainlinkOracles.rsEthEth, MockChainlinkAggregatorArtifact);
            await chainlinkRethEthOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            await rethPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await rethPriceFeed.priceSource();
            const lastGoodPrice = await rethPriceFeed.lastGoodPrice();

            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await reth.getExchangeRate();

            const calculatedPrice = calculateRate(ethUsdPrice, canonicalRate);
            const expectedPrice = calculatedPrice.lt(lastGoodPrice) ? calculatedPrice : lastGoodPrice;

            expect(lastGoodPrice.eq(expectedPrice)).to.be.true;
            expect(priceSource).to.equal(1);
        });

        it("RETHPriceFeed: should use eth/usd x canonical rate if steth/usd oracle returns 0 price", async () => {
            chainlinkRethEthOracle = await etchContract(chainlinkOracles.rsEthEth, MockChainlinkAggregatorArtifact);
            await chainlinkRethEthOracle.setPrice(hre.ethers.utils.parseUnits("0", 8));
            await chainlinkRethEthOracle.setUpdateTime(block.timestamp);
            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            await rethPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await rethPriceFeed.priceSource();
            const lastGoodPrice = await rethPriceFeed.lastGoodPrice();

            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await reth.getExchangeRate();
            const calculatedPrice = calculateRate(ethUsdPrice, canonicalRate);
            const expectedPrice = calculatedPrice.lt(lastGoodPrice) ? calculatedPrice : lastGoodPrice;

            expect(lastGoodPrice.eq(expectedPrice)).to.be.true;
            expect(priceSource).to.equal(1);
        });

        it("RETHPriceFeed: should have correct stored staleness for chainlink steth/usd oracle", async () => {
            const oracle = await rethPriceFeed.rEthEthOracle();
            expect(oracle.stalenessThreshold.eq(BigNumber.from(TimeValues.SECONDS_IN_ONE_DAY))).to.be.true;
        });

        it("RETHPriceFeed: should have correct stored staleness for chainlink eth/usd oracle", async () => {
            const oracle = await rethPriceFeed.ethUsdOracle();
            expect(oracle.stalenessThreshold.eq(BigNumber.from(stalenessThreshold))).to.be.true;
        });



        it("RETHPriceFeed: price source should be lastGoodPrice and should return lastGoodPrice when canonical exchange rate fails", async () => {
            await rethPriceFeed.fetchPrice();
            const lastGoodPrice = await rethPriceFeed.lastGoodPrice();
            reth = await etchContract(tokens.reth, MockRETHArtifact);
            await reth.setExchangeRate(BigNumber.from(dec(0,18)));

            const tx = await rethPriceFeed.fetchPrice();
            const receipt = await tx.wait();
            const event = getEvent(receipt, "ShutDownFromOracleFailure");

            const priceSource = await rethPriceFeed.priceSource();
            const priceAfterFailure = await rethPriceFeed.lastGoodPrice();

            expect(priceSource).to.equal(2);
            expect(event).to.exist;
            expect(lastGoodPrice.eq(priceAfterFailure)).to.be.true;
        });

        it("RETHPriceFeed: price source should be lastGoodPrice and should return lastGoodPrice when Eth/USD oracle isStale", async () => {
            await rethPriceFeed.fetchPrice();
            const price1 = await rethPriceFeed.lastGoodPrice();
            const priceSource1 = await rethPriceFeed.priceSource();
            expect(price1.gt(BigNumber.from(0))).to.be.true;
            expect(priceSource1).to.equal(0);

            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            const staleTime = block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1);
            await chainlinkEthUsdOracle.setUpdateTime(staleTime);
            const roundData = await chainlinkEthUsdOracle.latestRoundData();
            expect(roundData.updatedAt.eq(BigNumber.from(staleTime))).to.be.true;

            await rethPriceFeed.fetchPrice();
            const price2 = await rethPriceFeed.lastGoodPrice();
            const priceSource2 = await rethPriceFeed.priceSource();
            expect(price2.eq(price1)).to.be.true;
            expect(priceSource2).to.equal(2);
        });

        it("RETHPriceFeed: price source should be lastGoodPrice and should return lastGoodPrice when Eth/USD oracle returns 0 price", async () => {
            await rethPriceFeed.fetchPrice();
            const price1 = await rethPriceFeed.lastGoodPrice();
            const priceSource1 = await rethPriceFeed.priceSource();
            expect(price1.gt(BigNumber.from(0))).to.be.true;
            expect(priceSource1).to.equal(0);

            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            await chainlinkEthUsdOracle.setPrice(hre.ethers.utils.parseUnits("0", 8));
            await chainlinkEthUsdOracle.setUpdateTime(block.timestamp);
            const roundData = await chainlinkEthUsdOracle.latestRoundData();
            expect(roundData.answer.eq(BigNumber.from(0))).to.be.true;

            await rethPriceFeed.fetchPrice();
            const price2 = await rethPriceFeed.lastGoodPrice();
            const priceSource2 = await rethPriceFeed.priceSource();
            expect(price2.eq(price1)).to.be.true;
            expect(priceSource2).to.equal(2);
        });

        it("RETHPriceFeed: fetch price should return min ETHUSD x canonical rate or lastGoodPrice when Steth/usd oracle is stale and price source should be ETHUSDXCanonicalRate", async () => {
            await rethPriceFeed.fetchPrice();
            const priceBeforeFailure = await rethPriceFeed.lastGoodPrice();
            const priceSourceBeforeFailure = await rethPriceFeed.priceSource();
            expect(priceBeforeFailure.gt(BigNumber.from(0))).to.be.true;
            expect(priceSourceBeforeFailure).to.be.equal(0);


            chainlinkRethEthOracle = await etchContract(chainlinkOracles.rsEthEth, MockChainlinkAggregatorArtifact);
            const staleTime = block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1);
            await chainlinkRethEthOracle.setUpdateTime(staleTime);
            const roundData = await chainlinkRethEthOracle.latestRoundData();
            expect(roundData.updatedAt.eq(BigNumber.from(staleTime))).to.be.true;

            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            const tx = await rethPriceFeed.fetchPrice({ gasLimit: 2000000 });
            const receipt = await tx.wait();
           
            // assert that oracle did fail
            const event = getEvent(receipt, "ShutDownFromOracleFailure");
            expect(event).to.exist;
            expect(event.args._failedOracleAddr).to.equal(chainlinkOracles.rsEthEth);
            const priceSourceAfterFailure = await rethPriceFeed.priceSource();

            expect(priceSourceAfterFailure).to.equal(1);

            const lastGoodAfterFailure = await rethPriceFeed.lastGoodPrice();

            const ethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const canonicalRate = await reth.getExchangeRate();
            const calculatedPrice = calculateRate(ethUsdPrice, canonicalRate);

            const expectedPrice = calculatedPrice.lt(lastGoodAfterFailure) ? calculatedPrice : lastGoodAfterFailure;

            expect(lastGoodAfterFailure.eq(expectedPrice)).to.be.true;
        });

        it("RETHPriceFeed: When Using ETHUSDxCanonical, it remains shut down when ETHUSDOracle fails", async () => {
            await rethPriceFeed.fetchPrice();
            const priceBeforeFailure = await rethPriceFeed.lastGoodPrice();
            const priceSourceBeforeFailure = await rethPriceFeed.priceSource();
            expect(priceSourceBeforeFailure).to.be.equal(0);

            chainlinkRethEthOracle = await etchContract(chainlinkOracles.rsEthEth, MockChainlinkAggregatorArtifact);
            await chainlinkRethEthOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            const tx = await rethPriceFeed.fetchPrice({ gasLimit: 2000000 });
            const receipt = await tx.wait();

            // assert that oracle did fail
            const event = getEvent(receipt, "ShutDownFromOracleFailure");
            expect(event).to.exist;
            expect(event.args._failedOracleAddr).to.equal(chainlinkOracles.rsEthEth);

            const priceSourceAfterStethFailure = await rethPriceFeed.priceSource();
            expect(priceSourceAfterStethFailure).to.be.equal(1);

            // mock eth/usd oracle
            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            await chainlinkEthUsdOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            await rethPriceFeed.fetchPrice();

            const priceSourceAfterEthUsdFailure = await rethPriceFeed.priceSource();
            expect(priceSourceAfterEthUsdFailure).to.be.equal(2);
        });
    });
    
    function calculateWbtcPrice(btcUsdPrice, wbtcBtcPrice, isRedemption) {
        // Scale up prices by 10 digits (matching the pattern from other calculate functions)
        const btcUsdPriceWith10Digits = btcUsdPrice.mul(BigNumber.from(dec(1,10)));
        const wbtcBtcPriceWith10Digits = wbtcBtcPrice.mul(BigNumber.from(dec(1,10)));
        
        // Constants
        const DECIMAL_PRECISION = BigNumber.from(dec(1, 18));
        const WBTC_BTC_DEVIATION_THRESHOLD = BigNumber.from(dec(2, 16)); // 2%
        
        // Calculate the market WBTC-USD price: USD_per_WBTC = USD_per_BTC * BTC_per_WBTC
        const wbtcUsdMarketPrice = btcUsdPriceWith10Digits.mul(wbtcBtcPriceWith10Digits).div(DECIMAL_PRECISION);
        
        // For WBTC, canonical rate is always 1 BTC per WBTC, so canonical price equals BTC-USD price
        const wbtcUsdCanonicalPrice = btcUsdPriceWith10Digits;
        
        let wbtcUsdPrice;
        
        // Check if prices are within deviation threshold (2%)
        function withinDeviationThreshold(priceToCheck, referencePrice, deviationThreshold) {
            const max = referencePrice.mul(DECIMAL_PRECISION.add(deviationThreshold)).div(DECIMAL_PRECISION);
            const min = referencePrice.mul(DECIMAL_PRECISION.sub(deviationThreshold)).div(DECIMAL_PRECISION);
            return priceToCheck.gte(min) && priceToCheck.lte(max);
        }
        
        // If it's a redemption and within 2% deviation, take the max to prevent value leakage
        if (isRedemption && withinDeviationThreshold(wbtcUsdMarketPrice, wbtcUsdCanonicalPrice, WBTC_BTC_DEVIATION_THRESHOLD)) {
            wbtcUsdPrice = wbtcUsdMarketPrice.gt(wbtcUsdCanonicalPrice) ? wbtcUsdMarketPrice : wbtcUsdCanonicalPrice;
        } else {
            // Take the minimum of (market, canonical) to mitigate against upward market price manipulation
            wbtcUsdPrice = wbtcUsdMarketPrice.lt(wbtcUsdCanonicalPrice) ? wbtcUsdMarketPrice : wbtcUsdCanonicalPrice;
        }
        
        return wbtcUsdPrice;
    }

    describe.skip("WBTCPriceFeed", () => {
        let wbtcPriceFeed;
        let chainlinkWbtcBtcOracle;
        let chainlinkBtcUsdOracle;
        let wbtc;
        
        beforeEach(async () => {
            // Reset fork state before each test
            await hre.network.provider.request({
                method: "hardhat_reset",
                params: [
                    {
                        forking: {
                            jsonRpcUrl: process.env.MAINNET_RPC_URL || `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
                            blockNumber: 22894418,
                        },
                    },
                ],

        });
           
        block = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
        const deployerWallet = (await ethers.getSigners())[0];
        const deployerWalletAddress = deployerWallet.address;

        chainlinkWbtcBtcOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.wbtcBtc, deployerWallet);
        chainlinkBtcUsdOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.btcUsd, deployerWallet);

        wbtc = await ethers.getContractAt("IWBTCToken", tokens.wbtc, deployerWallet);

        
        const WBTCPriceFeedFactory = await ethers.getContractFactory("WBTCPriceFeed", deployerWallet);

        // deploy price feeds
        wbtcPriceFeed = await WBTCPriceFeedFactory.deploy(
            chainlinkOracles.wbtcBtc,
            chainlinkOracles.btcUsd,
            stalenessThreshold,
            stalenessThreshold
        )
        });
        it("WBTCPriceFeed: lastGoodPrice should be set on deployment", async () => {
            const price = await wbtcPriceFeed.lastGoodPrice();
            expect(price.gt(BigNumber.from(dec(0,18)))).to.be.true;
        });

        it("WBTCPriceFeed: should get the price of wbtc in usd", async () => {
            await wbtcPriceFeed.fetchPrice();
            const price = await wbtcPriceFeed.lastGoodPrice();
            const wbtcBtcPrice = (await chainlinkWbtcBtcOracle.latestRoundData()).answer;
            const btcUsdPrice = (await chainlinkBtcUsdOracle.latestRoundData()).answer;
            const canonicalPrice = calculateWbtcPrice(btcUsdPrice, wbtcBtcPrice, false);
            expect(price.eq(canonicalPrice)).to.be.true;
        });
        
        it("WBTCPriceFeed: should use lastgoodprice if Wbtc/Btc oracle is stale", async () => {
            const lastGoodPriceBeforeStale = await wbtcPriceFeed.lastGoodPrice();
            // etch chainlink reth/eth oracle with mock chainlink aggregator
            chainlinkWbtcBtcOracle = await etchContract(chainlinkOracles.wbtcBtc, MockChainlinkAggregatorArtifact);
            await chainlinkWbtcBtcOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            await wbtcPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await wbtcPriceFeed.priceSource();
            const lastGoodPrice = await wbtcPriceFeed.lastGoodPrice();

            expect(lastGoodPrice.eq(lastGoodPriceBeforeStale)).to.be.true;
            expect(priceSource).to.equal(2);
        });

        it("WBTCPriceFeed: should use lastgoodprice if wbtc/btc oracle returns 0 price", async () => {
            const lastGoodPriceBeforeStale = await wbtcPriceFeed.lastGoodPrice();   
            chainlinkWbtcBtcOracle = await etchContract(chainlinkOracles.wbtcBtc, MockChainlinkAggregatorArtifact);
            await chainlinkWbtcBtcOracle.setPrice(hre.ethers.utils.parseUnits("0", 8));
            await chainlinkWbtcBtcOracle.setUpdateTime(block.timestamp);
            // set gas limit to 2000000 to avoid out of gas error which causes call to getCanonicalRate to fail
            await wbtcPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await wbtcPriceFeed.priceSource();
            const lastGoodPrice = await wbtcPriceFeed.lastGoodPrice();

            expect(lastGoodPrice.eq(lastGoodPriceBeforeStale)).to.be.true;
            expect(priceSource).to.equal(2);
        });

        it("WBTCPriceFeed: should have correct stored staleness for chainlink wbtc/btc oracle", async () => {
            const oracle = await wbtcPriceFeed.btcUsdOracle();
            expect(oracle.stalenessThreshold.eq(BigNumber.from(TimeValues.SECONDS_IN_ONE_DAY))).to.be.true;
        });

        it("WBTCPriceFeed: should have correct stored staleness for chainlink btc/usd oracle", async () => {
            const oracle = await wbtcPriceFeed.wbtcBtc();
            expect(oracle.stalenessThreshold.eq(BigNumber.from(stalenessThreshold))).to.be.true;
        });


    });

    describe.skip("WETHPriceFeed", () => {
        let wethPriceFeed;
        let chainlinkEthUsdOracle;
        let weth;

        beforeEach(async () => {
            // Reset fork state before each test
            await hre.network.provider.request({
                method: "hardhat_reset",
                params: [
                    {
                        forking: {
                            jsonRpcUrl: process.env.MAINNET_RPC_URL || `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
                            // Optional: pin to specific block for consistency
                            blockNumber: 22894418,
                        },
                    },
                ],
            });

            block = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
            const deployerWallet = (await ethers.getSigners())[0];
            const deployerWalletAddress = deployerWallet.address;

            chainlinkEthUsdOracle = await ethers.getContractAt(AggregatorV3InterfaceArtifact.abi, chainlinkOracles.ethUsd, deployerWallet);
            weth = await ethers.getContractAt("IWETH", tokens.weth, deployerWallet);

            const WETHPriceFeedFactory = await ethers.getContractFactory("WETHPriceFeed", deployerWallet);

            wethPriceFeed = await WETHPriceFeedFactory.deploy(
                chainlinkOracles.ethUsd,
                stalenessThreshold
            )
        });

        it("WETHPriceFeed: lastGoodPrice should be set on deployment", async () => {
            const price = await wethPriceFeed.lastGoodPrice();
            expect(price.gt(BigNumber.from(dec(0,18)))).to.be.true;
        });

        it("WETHPriceFeed: should get the price of weth in usd", async () => {
            await wethPriceFeed.fetchPrice();
            const price = await wethPriceFeed.lastGoodPrice();
            const wethUsdPrice = (await chainlinkEthUsdOracle.latestRoundData()).answer;
            const priceSource = await wethPriceFeed.priceSource();

            expect(price.eq(wethUsdPrice.mul(BigNumber.from(dec(1,10))))).to.be.true;
            expect(priceSource).to.equal(0);
        });

        it("WETHPriceFeed: should use lastgoodprice if weth/usd oracle is stale", async () => {
            const lastGoodPriceBeforeStale = await wethPriceFeed.lastGoodPrice();
            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            await chainlinkEthUsdOracle.setUpdateTime(block.timestamp - (TimeValues.SECONDS_IN_ONE_DAY + 1));
            await wethPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await wethPriceFeed.priceSource();
            const lastGoodPrice = await wethPriceFeed.lastGoodPrice();

            expect(lastGoodPrice.eq(lastGoodPriceBeforeStale)).to.be.true;
            expect(priceSource).to.equal(2);
        });
        
        it("WETHPriceFeed: should use lastgoodprice if weth/usd oracle returns 0 price", async () => {
            const lastGoodPriceBeforeStale = await wethPriceFeed.lastGoodPrice();
            chainlinkEthUsdOracle = await etchContract(chainlinkOracles.ethUsd, MockChainlinkAggregatorArtifact);
            await chainlinkEthUsdOracle.setPrice(hre.ethers.utils.parseUnits("0", 8));
            await chainlinkEthUsdOracle.setUpdateTime(block.timestamp);
            await wethPriceFeed.fetchPrice({ gasLimit: 2000000 });

            const priceSource = await wethPriceFeed.priceSource();
            const lastGoodPrice = await wethPriceFeed.lastGoodPrice();

            expect(lastGoodPrice.eq(lastGoodPriceBeforeStale)).to.be.true;
            expect(priceSource).to.equal(2);
        });
        
    });
})