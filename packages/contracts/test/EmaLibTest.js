const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const testInvariants = require("../utils/testInvariants.js")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const LiquidationsTester = artifacts.require("./LiquidationsTester.sol")
const AggregatorTester = artifacts.require("./AggregatorTester.sol")
const RelayerTester = artifacts.require("./RelayerTester.sol")
const RateControlTester = artifacts.require("./RateControlTester.sol")
const FeeRouterTester = artifacts.require("./FeeRouterTester.sol")
const GlobalFeeRouterTester = artifacts.require("./GlobalFeeRouterTester.sol")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester.sol")
const EmaTester = artifacts.require("./EmaTester.sol")
const EmaLib = artifacts.require("./EmaLib.sol")
const BigNumber = require("@ethersproject/bignumber");

const Decimal = require("@liquity/lib-base");

const th = testHelpers.TestHelper
const ti = testInvariants.TestInvariant
const dec = th.dec
const toBN = th.toBN
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const GAS_PRICE = 10000000

contract('GlobalFeeRouter', async accounts => {

  const ZERO_ADDRESS = th.ZERO_ADDRESS
  const ONE_DOLLAR = toBN(dec(1, 18))
  const ONE_CENT = toBN(dec(1, 16))

  const [
    owner,
    alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
    defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
    A, B, C, D, E] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)
  

  let priceFeed
  let lusdToken
  let sortedTroves
  let sortedShieldedTroves
  let troveManager
  let rewards
  let activePool
  let activeShieldedPool
  let stabilityPool
  let collSurplusPool
  let defaultPool
  let borrowerOperations
  let hintHelpers
  let collateralToken
  let lpStaking

  let contracts

  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.aggregator = await AggregatorTester.new()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts.feeRouter = await FeeRouterTester.new()
    contracts.globalFeeRouter = await GlobalFeeRouterTester.new()
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
    sortedShieldedTroves = contracts.sortedShieldedTroves
    aggregator = contracts.aggregator
    troveManager = contracts.troveManager
    rewards = contracts.rewards
    feeRouter = contracts.feeRouter
    globalFeeRouter = contracts.globalFeeRouter
    liquidations = contracts.liquidations
    activePool = contracts.activePool
    activeShieldedPool = contracts.activeShieldedPool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    collSurplusPool = contracts.collSurplusPool
    borrowerOperations = contracts.borrowerOperations
    hintHelpers = contracts.hintHelpers
    relayer = contracts.relayer
    parControl = contracts.parControl
    rateControl = contracts.rateControl
    marketOracle = contracts.marketOracleTestnet
    collateralToken = contracts.collateralToken
    lpStaking = contracts.lpStaking

    lqtyStaking = LQTYContracts.lqtyStaking
    lqtyToken = LQTYContracts.lqtyToken
    communityIssuance = LQTYContracts.communityIssuance
    lockupContractFactory = LQTYContracts.lockupContractFactory

    ema = await EmaTester.new()


    await th.batchMintCollateralTokensAndApproveActivePool(contracts, [
      owner,
      alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
      defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
      A, B, C, D, E], toBN(dec(1000, 26)))

    // Interfaces
    stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;
    feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
    globalFeeRouterInterface = (await ethers.getContractAt("GlobalFeeRouter", globalFeeRouter.address)).interface;
    liquidationsInterface = (await ethers.getContractAt("Liquidations", liquidations.address)).interface;
    collSurplusPoolInterface = (await ethers.getContractAt("CollSurplusPool", collSurplusPool.address)).interface;
    borrowerOperationsInterface = (await ethers.getContractAt("BorrowerOperations", borrowerOperations.address)).interface;

    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)
  })

  afterEach(async () => {
    assert.isTrue(await ti.SpBalanceEqualsErc20Balance(contracts))
    assert.isTrue(await ti.debtEqualsSupply(contracts))
  })

  it('calcDecay(): no decay', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)

      decay = await ema.decayFactor(0)
      assert.isTrue(decay.eq(toBN(dec(1,27))))

      secs_w_no_decay = await ema.halflife() / await ema.maxDecayIdx()

      for (let i = 0; i < secs_w_no_decay-1; i=i+600) {
          decay = await ema.decayFactor(i)
          assert.isTrue(decay.eq(toBN(dec(1,27))))
      }

      // one sec before decay starts
      assert.isTrue((await ema.decayFactor(secs_w_no_decay-1)).eq(toBN(dec(1,27))))

      // decay starts after HALFLIFE/24 hours
      assert.isTrue((await ema.decayFactor(secs_w_no_decay)).lt(toBN(dec(1,27))))
  })
  it('calcDecay(): max decay', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)


      // dt before max decay
      full_decay_minus_1 = await ema.decayByIdx((await ema.maxDecayIdx())-1)
      for (let i = halflife-600; i < halflife-1; i++) {
          decay = await ema.decayFactor(i)
          assert.isTrue(decay.eq(full_decay_minus_1))
      }

      // dt = HALFLIFE -> max decay of 50% at final idx
      assert.isTrue((await ema.decayFactor(halflife)).eq(await ema.decayByIdx(await ema.maxDecayIdx())))
      assert.isTrue((await ema.decayFactor(halflife)).eq(toBN(dec(50,25))))

      // dt > halflife -> max decay
      for (let i = halflife; i < halflife.mul(toBN('10')); i=i+600) {
          decay = await ema.decayFactor(i)
          assert.isTrue(decay.eq(toBN(dec(50,25))))
      }
  })

  it('previewCurrent(): ema doesnt decrease immediately', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)

      firstEma = await ema.ema()

      secs_w_no_decay = await ema.halflife() / await ema.maxDecayIdx()

      timeSince = await th.getLatestBlockTimestamp(web3) - await ema.lastUpdate()
      while (timeSince < secs_w_no_decay-200) {
          await th.fastForwardTime(200, web3.currentProvider)
          const {0: nextEma} = await ema.previewCurrent(firstEma.sub(toBN(dec(5,16))))
          assert.isTrue(nextEma.eq(firstEma))
          timeSince = await th.getLatestBlockTimestamp(web3) - await ema.lastUpdate()
      }

      await th.fastForwardTime(200, web3.currentProvider)
      const {0: nextEma} = await ema.previewCurrent(firstEma.sub(toBN(dec(5,16))))

      assert.isTrue(nextEma.lt(firstEma))

  })
  it('previewCurrent(): ema decreases after initial zero decay period', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)

      firstEma = await ema.ema()

      secs_w_no_decay = await ema.halflife() / await ema.maxDecayIdx()

      await th.fastForwardTime(secs_w_no_decay, web3.currentProvider)
      const { 0: nextEma} = await ema.previewCurrent(firstEma.sub(toBN(dec(5,16))))
      assert.isTrue(nextEma.lt(firstEma))
  })
  it('previewCurrent(): next ema at max decay clamp is 50% old value and 50% new value', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)

      firstEma = await ema.ema()

      // 1 half-life
      currentValue1 = toBN(dec(12,16))
      await th.fastForwardTime(halflife, web3.currentProvider)
      const { 0: nextEma1} = await ema.previewCurrent(currentValue1)
      // 50% of ema and 50% of current value
      th.assertIsApproximatelyEqual(nextEma1, firstEma.div(toBN('2')).add(currentValue1.div(toBN('2'))))

      // 2 half-lifes
      currentValue2 = toBN(dec(31,16))
      await th.fastForwardTime(halflife.mul(toBN('2')), web3.currentProvider)
      const { 0: nextEma2} = await ema.previewCurrent(currentValue2)
      // 50% of ema and 50% of current value
      th.assertIsApproximatelyEqual(nextEma2, firstEma.div(toBN('2')).add(currentValue2.div(toBN('2'))))

      // 10 half-lifes
      currentValue3 = toBN(dec(19,16))
      await th.fastForwardTime(halflife.mul(toBN('10')), web3.currentProvider)
      const { 0: nextEma3} = await ema.previewCurrent(currentValue3)
      // 50% of ema and 50% of current value
      th.assertIsApproximatelyEqual(nextEma3, firstEma.div(toBN('2')).add(currentValue3.div(toBN('2'))))

  })

  it('update(): ema doesnt decrease immediately', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)

      firstEma = await ema.ema()

      secs_w_no_decay = halflife / await ema.maxDecayIdx()

      timeSince = await th.getLatestBlockTimestamp(web3) - await ema.lastUpdate()
      while (timeSince < secs_w_no_decay-200) {
          await th.fastForwardTime(200, web3.currentProvider)
          await ema.update(firstEma.sub(toBN(dec(5,16))))
          newEma = await ema.ema()
          assert.isTrue(newEma.eq(firstEma))
          timeSince = await th.getLatestBlockTimestamp(web3) - await ema.lastUpdate()
      }

      await th.fastForwardTime(200, web3.currentProvider)

      //finally ema decreases
      timeSince = toBN(await th.getLatestBlockTimestamp(web3)).sub(await ema.lastUpdate())

      decay = await ema.decayFactor(timeSince)
      assert.isTrue(decay.lt(toBN(dec(1,27))))

      await ema.update(firstEma.sub(toBN(dec(5,16))))

      newEma = await ema.ema()
      assert.isTrue(newEma.lt(firstEma))
  })
  it('update(): new ema at max decay clamp is 50% old value and 50% new value', async () => {
      target = await contracts.globalFeeRouter.targetLpUtil()
      halflife = await contracts.globalFeeRouter.HALFLIFE()
      await ema.init(target, halflife)

      firstEma = await ema.ema()

      // 1 half-life
      currentValue1 = toBN(dec(12,16))
      await th.fastForwardTime(halflife, web3.currentProvider)
      await ema.update(currentValue1)
      // 50% of ema and 50% of current value
      th.assertIsApproximatelyEqual(await ema.ema(), firstEma.div(toBN('2')).add(currentValue1.div(toBN('2'))))
      ema1 = await ema.ema()

      // 2 half-lifes
      currentValue2 = toBN(dec(31,16))
      await th.fastForwardTime(halflife.mul(toBN('2')), web3.currentProvider)
      await ema.update(currentValue2)
      th.assertIsApproximatelyEqual(await ema.ema(), ema1.div(toBN('2')).add(currentValue2.div(toBN('2'))))
      ema2 = await ema.ema()

      // 10 half-lifes
      currentValue3 = toBN(dec(19,16))
      await th.fastForwardTime(halflife.mul(toBN('10')), web3.currentProvider)
      await ema.update(currentValue3)
      // 50% of ema and 50% of current value
      th.assertIsApproximatelyEqual(await ema.ema(), ema2.div(toBN('2')).add(currentValue3.div(toBN('2'))))
  })

  /*
   * 	1.	Control clock: call allocateFees(0) twice in the same block → integral should not change on the 2nd call.
	2.	Spam within first bucket: many calls at dt < HALFLIFE/24 → EMA unchanged; integral grows only with real elapsed time, not #calls.
	3.	Long gap: simulate dt ≈ 3 * HALFLIFE → decay weight ≈ (table remainder) / 8.
	4.	Reentrancy attempt: make SP/GFR try to reenter via TM; ensure revert by nonReentrant.
	5.	Zero-fee path: no external calls made; clocks still advance; event emits zeros.
  */
})

contract('Reset chain state', async accounts => { })
