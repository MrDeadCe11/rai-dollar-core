const {time} = require('@openzeppelin/test-helpers');
const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const RelayerTester = artifacts.require("./RelayerTester.sol")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester.sol")

const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const GAS_PRICE = 10000000

contract('Relayer', async accounts => {

  const _18_zeros = '000000000000000000'
  const ONE_DOLLAR = toBN(dec(1, 18))
  const ZERO_RATE = toBN(dec(1, 27))
  const ONE_CENT = toBN(dec(1, 16))
  const ZERO_ADDRESS = th.ZERO_ADDRESS

  const [
    owner,
    alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
    defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
    A, B, C, D, E] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let activePool
  let stabilityPool
  let collSurplusPool
  let defaultPool
  let borrowerOperations
  let hintHelpers

  let contracts

  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.relayer = await RelayerTester.new()
    contracts.lusdToken = await LUSDTokenTester.new(
      contracts.troveManager.address,
      contracts.liquidations.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address,
      contracts.globalFeeRouter.address
    )
    const LQTYContracts = await deploymentHelper.deployLQTYContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    troveManager = contracts.troveManager
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    hintHelpers = contracts.hintHelpers
    relayer = contracts.relayer
    marketOracle = contracts.marketOracleTestnet
    rateControl = contracts.rateControl


    lqtyStaking = LQTYContracts.lqtyStaking
    lqtyToken = LQTYContracts.lqtyToken
    communityIssuance = LQTYContracts.communityIssuance
    lockupContractFactory = LQTYContracts.lockupContractFactory

    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)
  })

  it('rateControlError(): various errors', async () => {

    marketPrice = ONE_DOLLAR;
    error = await relayer.rateControlError(marketPrice);
    assert.isTrue(error.eq(toBN(0)));

    marketPrice = 0;
    error = await relayer.rateControlError(marketPrice);
    assert.equal(error, 10**27);

    marketPrice = toBN(95).mul(ONE_CENT);
    error = await relayer.rateControlError(marketPrice);
    //assert.equal(error.toString(), toBN(5*10**25).toString());
    assert.equal(error, 5*10**25);

    marketPrice = toBN(105).mul(ONE_CENT);
    error = await relayer.rateControlError(marketPrice);
    //assert.equal(error.toString(), toBN(-5*10**25).toString());
    assert.equal(error, -5*10**25);

  })
  it('parControlError(): various errors', async () => {

    marketPrice = ONE_DOLLAR;
    error = await relayer.parControlError(marketPrice);
    assert.isTrue(error.eq(toBN(0)));

    marketPrice = 0;
    error = await relayer.parControlError(marketPrice);
    assert.equal(error, 10**18);

    marketPrice = toBN(95).mul(ONE_CENT);
    error = await relayer.parControlError(marketPrice);
    assert.equal(error.toString(), toBN(5*10**16).toString());

    marketPrice = toBN(105).mul(ONE_CENT);
    error = await relayer.parControlError(marketPrice);
    assert.equal(error.toString(), toBN(-5*10**16).toString());

  })

  it('rampErrorDec(): various errors', async () => {
    eps_1 = toBN(dec(1, 15))
    eps_2 = toBN(dec(3, 15))

    // positive errors
    // full error
    marketPrice = ONE_DOLLAR.sub(eps_2);
    error = await relayer.parControlError(marketPrice);
    rampError = await relayer.rampErrorDec(error, eps_1, eps_2);
    assert(rampError.eq(error));
    assert(rampError.eq(toBN(eps_2)));

    // ramped error
    marketPrice = ONE_DOLLAR.sub(eps_2.sub(toBN(10000)));
    error = await relayer.parControlError(marketPrice);
    rampError = await relayer.rampErrorDec(error, eps_1, eps_2);
    assert.isTrue(rampError.lt(error));
    assert(rampError.lt(toBN(eps_2-10000)));
 
    // zero error
    marketPrice = ONE_DOLLAR.sub(eps_1);
    error = await relayer.parControlError(marketPrice);
    rampError = await relayer.rampErrorDec(error, eps_1, eps_2);
    assert.isTrue(rampError.eq(toBN(0)));
    assert(rampError.lt(toBN(eps_1)));

    // negative errors
    // full error
    marketPrice = ONE_DOLLAR.add(eps_2);
    error = await relayer.parControlError(marketPrice);
    rampError = await relayer.rampErrorDec(error, eps_1, eps_2);
    assert(rampError.eq(error));

    // ramped error
    marketPrice = ONE_DOLLAR.add(eps_2.sub(toBN(10000)));
    error = await relayer.parControlError(marketPrice);

    assert.isTrue(Math.abs(error) < eps_2)
    rampError = await relayer.rampErrorDec(error, eps_1, eps_2);
    assert.isTrue(rampError.gt(error));
    assert(rampError.gt(toBN(-eps_2+10000)));
 
    // zero error
    marketPrice = ONE_DOLLAR.add(eps_1);
    error = await relayer.parControlError(marketPrice);
    rampError = await relayer.rampErrorDec(error, eps_1, eps_2);
    assert.isTrue(rampError.eq(toBN(0)));
  })
  it('rampErrorRay(): various errors', async () => {
    eps_1 = toBN(dec(1, 24))
    eps_2 = toBN(dec(3, 24))

    // positive errors
    // full error
    marketPrice = ONE_DOLLAR.sub(eps_2.div(toBN(10**9)));
    error = await relayer.rateControlError(marketPrice);
    rampError = await relayer.rampErrorRay(error, eps_1, eps_2);
    assert(rampError.eq(error));
    assert(rampError.eq(toBN(eps_2)));

    // ramped error

    dec_error = eps_2.div(toBN(10**9)).sub(toBN(10000))
    marketPrice = ONE_DOLLAR.sub(dec_error);
    error = await relayer.rateControlError(marketPrice);
    rampError = await relayer.rampErrorRay(error, eps_1, eps_2);
    assert.isTrue(rampError.lt(error));
    assert(rampError.lt(dec_error.mul(toBN(10**9))));

 
    // zero error
    marketPrice = ONE_DOLLAR.sub(eps_1.div(toBN(10**9)));
    error = await relayer.rateControlError(marketPrice);
    rampError = await relayer.rampErrorRay(error, eps_1, eps_2);
    assert.isTrue(rampError.eq(toBN(0)));
    assert(rampError.lt(toBN(eps_1.div(toBN(10**9)))));

    // negative errors
    // full error
    marketPrice = ONE_DOLLAR.add(eps_2.div(toBN(10**9)));
    error = await relayer.rateControlError(marketPrice);
    rampError = await relayer.rampErrorRay(error, eps_1, eps_2);
    assert(rampError.eq(error));

    // ramped error
    dec_error = eps_2.div(toBN(10**9)).sub(toBN(10000));
    marketPrice = ONE_DOLLAR.add(dec_error);
    error = await relayer.rateControlError(marketPrice);

    assert.isTrue(Math.abs(error) < eps_2)
    rampError = await relayer.rampErrorRay(error, eps_1, eps_2);
    assert.isTrue(rampError.gt(error));
    assert(rampError.gt(toBN(-dec_error).mul(toBN(10**9))))
 
    // zero error
    marketPrice = ONE_DOLLAR.add(eps_1.div(toBN(10**9)));
    error = await relayer.rateControlError(marketPrice);
    rampError = await relayer.rampErrorRay(error, eps_1, eps_2);
    assert.isTrue(rampError.eq(toBN(0)));

  })
  it('getPar(): par not updated if called too early', async () => {
    // TODO fix in Relayer
    /*
    parStaleness = await relayer.MAX_PAR_STALENESS();

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par
    await relayer.getPar();
    updateTime = await relayer.lastParUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));
    assert((await relayer.par()).eq(ONE_DOLLAR));

    // update time changes
    assert.isTrue((await relayer.lastParUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = parStaleness.sub(toBN(10));
    await time.increase(timeForward);

    timeNew = timeStart.add(timeForward);
    timeNow = await time.latest();
    assert.isTrue(timeNow.eq(timeNew));

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.addn(10000));
    await relayer.getPar();

    // par is still previous value
    assert((await relayer.par()).eq(ONE_DOLLAR));

    // update time hasn't changed
    thisUpdateTime = await relayer.lastParUpdateTime();
    assert.isTrue(thisUpdateTime.eq(updateTime));
    */

  })
  it('getPar(): par updated if stale', async () => {

    parStaleness = await relayer.MAX_PAR_STALENESS();

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par
    firstPar = await relayer.par();
    await relayer.getPar();
    updateTime = await relayer.lastParUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));

    // update time changes
    assert.isTrue((await relayer.lastParUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = parStaleness.add(toBN(10));
    await time.increase(timeForward);

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(10, 17))));
    await relayer.getPar();

    // par is new value
    newPar = await relayer.par();
    assert(newPar.lt(firstPar));

    // update time has changed
    thisUpdateTime = await relayer.lastParUpdateTime();
    assert.isTrue(thisUpdateTime.gt(updateTime));

  })
  it('getRate(): rate not updated if called too early', async () => {

    rateStaleness = await relayer.MAX_RATE_STALENESS();

    rateBias = await rateControl.CO_BIAS();
    defaultRate = ZERO_RATE.add(rateBias);

    await marketOracle.setPrice(ONE_DOLLAR);

    // update rate
    await relayer.getRate();
    updateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));
    assert((await relayer.rate()).eq(defaultRate));


    // update time changes
    assert.isTrue((await relayer.lastRateUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = rateStaleness.sub(toBN(10));
    await time.increase(timeForward);

    timeNew = timeStart.add(timeForward);
    timeNow = await time.latest();
    assert.isTrue(timeNow.eq(timeNew));

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.addn(10000));
    await relayer.getRate();

    // rate is still previous value
    assert((await relayer.rate()).eq(defaultRate));

    // update time hasn't changed
    thisUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisUpdateTime.eq(updateTime));

  })
  it('getRate(): rate updated if stale', async () => {

    rateStaleness = await relayer.MAX_RATE_STALENESS();
    rateBias = await rateControl.CO_BIAS();
    defaultRate = ZERO_RATE.add(rateBias);

    await marketOracle.setPrice(ONE_DOLLAR);

    // update rate
    await relayer.getRate();
    updateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));
    assert((await relayer.rate()).eq(defaultRate));

    // update time changes
    assert.isTrue((await relayer.lastRateUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = rateStaleness.add(toBN(10));
    await time.increase(timeForward);

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(10, 17))));

    // update rate
    await relayer.getRate();

    // update time has changed
    thisUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisUpdateTime.gt(updateTime));

  })

  it('getRateAndPar(): par and rate not updated if called too early', async () => {
    parStaleness = await relayer.MAX_PAR_STALENESS();
    rateStaleness = await relayer.MAX_RATE_STALENESS();

    minStaleness = Math.min(parStaleness, rateStaleness);

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par
    await relayer.getRateAndPar();
    parUpdateTime = await relayer.lastParUpdateTime();
    rateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(parUpdateTime.eq(await time.latest()));
    assert.isTrue(rateUpdateTime.eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = toBN(minStaleness).sub(toBN(10));
    await time.increase(timeForward);

    timeNew = timeStart.add(timeForward);
    timeNow = await time.latest();
    assert.isTrue(timeNow.eq(timeNew));

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.addn(10000));
    await relayer.getRateAndPar();

    // par is still previous value
    assert((await relayer.par()).eq(ONE_DOLLAR));

    // update time hasn't changed
    thisParUpdateTime = await relayer.lastParUpdateTime();
    thisRateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisParUpdateTime.eq(parUpdateTime));
    assert.isTrue(thisRateUpdateTime.eq(parUpdateTime));

  })

  it('getRateAndPar(): par and rate updated when stale', async () => {
    parStaleness = await relayer.MAX_PAR_STALENESS();
    rateStaleness = await relayer.MAX_RATE_STALENESS();

    minStaleness = Math.max(parStaleness, rateStaleness);

    rateBias = await rateControl.CO_BIAS();
    defaultRate = ZERO_RATE.add(rateBias);

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par and rate
    tx = await relayer.getRateAndPar();

    const event = tx.logs.find(e => e.event === 'RateUpdated');

    firstPar = await relayer.par();
    firstRate = await relayer.rate();
    parUpdateTime = await relayer.lastParUpdateTime();
    rateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(parUpdateTime.eq(await time.latest()));
    assert.isTrue(rateUpdateTime.eq(await time.latest()));

    // update time changes
    assert.isTrue((await relayer.lastParUpdateTime()).eq(await time.latest()));
    assert.isTrue((await relayer.lastRateUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = toBN(minStaleness).add(toBN(10));
    await time.increase(timeForward);

    timeNew = timeStart.add(timeForward);
    timeNow = await time.latest();

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(1, 17))));
    tx = await relayer.getRateAndPar();

    newPar = await relayer.par();
    newRate = await relayer.rate();

    // par and rate have been updated
    assert(newPar.lt(firstPar));
    if (rateBias.eq(toBN(0))) {
        assert(newRate.eq(firstRate));
    } else {
        assert(newRate.lt(firstRate));
    }

    // update time has changed
    thisParUpdateTime = await relayer.lastParUpdateTime();
    thisRateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisParUpdateTime.gt(parUpdateTime));
    assert.isTrue(thisRateUpdateTime.gt(parUpdateTime));

  })
  it('updatePar(): par updated even if not stale', async () => {

    parStaleness = await relayer.MAX_PAR_STALENESS();

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par
    await relayer.updatePar();
    updateTime = await relayer.lastParUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));
    assert((await relayer.par()).eq(ONE_DOLLAR));

    // update time changes
    assert.isTrue((await relayer.lastParUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = parStaleness.sub(toBN(10));
    await time.increase(timeForward);

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(10, 17))));
    await relayer.updatePar();

    // par is new value
    assert((await relayer.par()).lt(ONE_DOLLAR));

    // update time has changed
    thisUpdateTime = await relayer.lastParUpdateTime();
    assert.isTrue(thisUpdateTime.gt(updateTime));

  })
  it('updateRate(): rate updated even if not stale', async () => {

    rateStaleness = await relayer.MAX_RATE_STALENESS();

    await marketOracle.setPrice(ONE_DOLLAR);

    // update rate
    await relayer.updateRate();
    updateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));
    assert((await relayer.rate()).eq(ZERO_RATE.add(rateBias)));

    // update time changes
    assert.isTrue((await relayer.lastRateUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = rateStaleness.sub(toBN(10));
    await time.increase(timeForward);

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(10, 17))));
    await relayer.updateRate();

    // update time has changed
    thisUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisUpdateTime.gt(updateTime));

  })
  it('updateRateAndPar(): rate and par updated even when not stale', async () => {
    parStaleness = await relayer.MAX_PAR_STALENESS();
    rateStaleness = await relayer.MAX_RATE_STALENESS();

    minStaleness = Math.max(parStaleness, rateStaleness);

    rateBias = await rateControl.CO_BIAS();
    defaultRate = ZERO_RATE.add(rateBias);

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par and rate
    tx = await relayer.updateRateAndPar();

    const event = tx.logs.find(e => e.event === 'RateUpdated');

    firstPar = await relayer.par();
    firstRate = await relayer.rate();
    parUpdateTime = await relayer.lastParUpdateTime();
    rateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(parUpdateTime.eq(await time.latest()));
    assert.isTrue(rateUpdateTime.eq(await time.latest()));
    assert((await relayer.par()).eq(ONE_DOLLAR));
    assert((await relayer.rate()).eq(defaultRate));

    // fast forward
    timeStart = await time.latest();
    timeForward = toBN(minStaleness).sub(toBN(10));
    await time.increase(timeForward);

    timeNew = timeStart.add(timeForward);
    timeNow = await time.latest();

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(1, 17))));
    await relayer.updateRateAndPar();

    newPar = await relayer.par();
    newRate = await relayer.rate();

    // par and rate have been updated
    assert(newPar.lt(firstPar));
    if (rateBias.eq(toBN(0))) {
        assert(newRate.eq(firstRate));
    } else {
        assert(newRate.lt(firstRate));
    }

    // update time has changed
    thisParUpdateTime = await relayer.lastParUpdateTime();
    thisRateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisParUpdateTime.gt(parUpdateTime));
    assert.isTrue(thisRateUpdateTime.gt(parUpdateTime));

  })
  it('updateParWithMarket(): par updated even if not stale', async () => {

    parStaleness = await relayer.MAX_PAR_STALENESS();

    //await marketOracle.setPrice(ONE_DOLLAR);

    // fund and impersonate marketOracle
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [
        marketOracle.address,
        "0x16345785D8A000000" // Amount in wei (e.g., 10000 Ether)
      ]
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [marketOracle.address],
    });

    await relayer.updateParWithMarket(dec(1, 18), {from:marketOracle.address});
    updateTime = await relayer.lastParUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));
    assert((await relayer.par()).eq(ONE_DOLLAR));

    // update time changes
    assert.isTrue((await relayer.lastParUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = parStaleness.sub(toBN(10));
    await time.increase(timeForward);

    // set different market price
    //await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(10, 17))));
    await relayer.updateParWithMarket(ONE_DOLLAR.add(toBN(dec(10, 17))), { from: marketOracle.address });

    // par is new value
    assert((await relayer.par()).lt(ONE_DOLLAR));

    // update time has changed
    thisUpdateTime = await relayer.lastParUpdateTime();
    assert.isTrue(thisUpdateTime.gt(updateTime));

  })
  it('updateRateWithMarket(): rate updated even if not stale', async () => {

    rateStaleness = await relayer.MAX_RATE_STALENESS();
    rateBias = await rateControl.CO_BIAS();
    defaultRate = ZERO_RATE.add(rateBias);

    //await marketOracle.setPrice(ONE_DOLLAR);

    // fund and impersonate marketOracle
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [
        marketOracle.address,
        "0x16345785D8A000000" // Amount in wei (e.g., 10000 Ether)
      ]
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [marketOracle.address],
    });

    await relayer.updateRateWithMarket(dec(1, 18), {from:marketOracle.address});
    updateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(updateTime.eq(await time.latest()));

    firstRate = await relayer.rate()
    assert(firstRate.eq(ZERO_RATE.add(rateBias)));

    // update time changes
    assert.isTrue((await relayer.lastRateUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = rateStaleness.sub(toBN(10));
    await time.increase(timeForward);

    // set different market price
    //await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(10, 17))));
    await relayer.updateRateWithMarket(ONE_DOLLAR.add(toBN(dec(10, 17))), {from:marketOracle.address});

    newRate = await relayer.rate()

    if (rateBias.eq(toBN(0))) {
        assert(newRate.eq(firstRate));
    } else {
        assert(newRate.lt(firstRate));
    }

    // update time has changed
    thisUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisUpdateTime.gt(updateTime));
  })
  it('updateRateAndPar(): par and rate updated when not stale', async () => {
    parStaleness = await relayer.MAX_PAR_STALENESS();
    rateStaleness = await relayer.MAX_RATE_STALENESS();

    minStaleness = Math.max(parStaleness, rateStaleness);

    rateBias = await rateControl.CO_BIAS();
    defaultRate = ZERO_RATE.add(rateBias);

    // fund and impersonate marketOracle
    await hre.network.provider.request({
      method: "hardhat_setBalance",
      params: [
        marketOracle.address,
        "0x16345785D8A000000" // Amount in wei (e.g., 10000 Ether)
      ]
    });

    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [marketOracle.address],
    });

    await marketOracle.setPrice(ONE_DOLLAR);

    // update par and rate
    tx = await relayer.updateRateAndPar();

    const event = tx.logs.find(e => e.event === 'RateUpdated');

    firstPar = await relayer.par();
    firstRate = await relayer.rate();
    parUpdateTime = await relayer.lastParUpdateTime();
    rateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(parUpdateTime.eq(await time.latest()));
    assert.isTrue(rateUpdateTime.eq(await time.latest()));

    // update time changes
    assert.isTrue((await relayer.lastParUpdateTime()).eq(await time.latest()));
    assert.isTrue((await relayer.lastRateUpdateTime()).eq(await time.latest()));

    // fast forward
    timeStart = await time.latest();
    timeForward = toBN(minStaleness).sub(toBN(10));
    await time.increase(timeForward);

    timeNew = timeStart.add(timeForward);
    timeNow = await time.latest();

    // set different market price
    await marketOracle.setPrice(ONE_DOLLAR.add(toBN(dec(1, 17))));
    tx = await relayer.updateRateAndPar();

    newPar = await relayer.par();
    newRate = await relayer.rate();

    // par and rate have been updated
    assert(newPar.lt(firstPar));
    if (rateBias.eq(toBN(0))) {
        assert(newRate.eq(firstRate));
    } else {
        assert(newRate.lt(firstRate));
    }

    // update time has changed
    thisParUpdateTime = await relayer.lastParUpdateTime();
    thisRateUpdateTime = await relayer.lastRateUpdateTime();
    assert.isTrue(thisParUpdateTime.gt(parUpdateTime));
    assert.isTrue(thisRateUpdateTime.gt(parUpdateTime));

  })
})
