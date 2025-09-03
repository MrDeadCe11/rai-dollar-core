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
const StabilityPoolTester = artifacts.require("./StabilityPoolTester.sol")
const LUSDTokenTester = artifacts.require("./LUSDTokenTester.sol")
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

contract('FeeRouter', async accounts => {

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
  const fakeIncreaseSPDeposits = async (amount) => th.fakeIncreaseSPDeposits(contracts, amount)
  const fakeDecreaseSPDeposits = async (amount) => th.fakeDecreaseSPDeposits(contracts, amount)
  const fakeResetSPDeposits = async () => th.fakeResetSPDeposits(contracts)

  beforeEach(async () => {
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.aggregator = await AggregatorTester.new()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts.feeRouter = await FeeRouterTester.new()
    contracts.globalFeeRouter = await GlobalFeeRouterTester.new()
    contracts.stabilityPool = await StabilityPoolTester.new()
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

    await th.batchMintCollateralTokensAndApproveActivePool(contracts, [
      owner,
      alice, bob, carol, dennis, erin, flyn, graham, harriet, ida,
      defaulter_1, defaulter_2, defaulter_3, defaulter_4, whale,
      A, B, C, D, E], toBN(dec(1000, 26)))

    // Interfaces
    stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;
    troveManagerInterface = (await ethers.getContractAt("TroveManager", troveManager.address)).interface;
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

  it('spUtilizationEma()(): fees to SP decrease if SP utilization goes up', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: carol } })

      // borrow extra to increase SP deposits later
      await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: dec(10, 24), extraParams: { from: whale } })

      // set starting SP deposit to create utilization=target utilization
      startSp = (await feeRouter.targetSpUtil()).mul(await aggregator.getEntireSystemDebt()).div(toBN(dec(1,18)))

      // initial SP deposit
      await stabilityPool.provideToSP(startSp, ZERO_ADDRESS, { from: whale })
      // sputil/debt
      spUtil = await feeRouter.spUtilizationEma()
      spAlloc = await feeRouter.spAllocFrac()

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)
      
      // Drip
      tx1 = await troveManager.drip()
      toSP1 = toBN(th.getRawEventArgByName(tx1, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));

      // No addition SP deposits, just interest accrual
      // sp util only drops from interest accrual when utilization/debt < spAllocFrac
      spUtil1 = await feeRouter.spUtilizationEma()
      //assert.isTrue(spUtil1.lt(spUtil))
      
      // no control output change, as small util change away from target with just interest accrual is still within deadband
      spAlloc1 = await feeRouter.spAllocFrac()
      assert.isTrue(spAlloc1.eq(spAlloc))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)
      // increase SP deposit
      await stabilityPool.provideToSP(startSp.div(toBN('2')), ZERO_ADDRESS, { from: whale })

      // Drip
      tx2 = await troveManager.drip() 
      toSP2 = toBN(th.getRawEventArgByName(tx2, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      // slight increase even though spAlloc1 = spAlloc because of compounding debt
      assert.isTrue(toSP2.gt(toSP1))

      // utilization ema increases
      spUtil2 = await feeRouter.spUtilizationEma()
      assert.isTrue(spUtil2.gt(spUtil1))

      // alloc decreases from util ema increse
      spAlloc2 = await feeRouter.spAllocFrac()
      assert.isTrue(spAlloc2.lt(spAlloc1))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)
      // increase SP deposit
      await stabilityPool.provideToSP(startSp.div(toBN('2')), ZERO_ADDRESS, { from: whale })

      // Drip
      tx3 = await troveManager.drip()
      toSP3 = toBN(th.getRawEventArgByName(tx3, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      assert.isTrue(toSP3.lt(toSP2))

      // utilization ema increases
      spUtil3 = await feeRouter.spUtilizationEma()
      assert.isTrue(spUtil3.gt(spUtil2))

      // alloc decreases from util ema increse
      spAlloc3 = await feeRouter.spAllocFrac()
      assert.isTrue(spAlloc3.lt(spAlloc2))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)
      // increase SP deposit
      await stabilityPool.provideToSP(startSp.div(toBN('2')), ZERO_ADDRESS, { from: whale })

      // Drip
      tx4 = await troveManager.drip()
      toSP4 = toBN(th.getRawEventArgByName(tx4, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      assert.isTrue(toSP4.lt(toSP3))

      // utilization ema increases
      spUtil4 = await feeRouter.spUtilizationEma()
      assert.isTrue(spUtil4.gt(spUtil3))

      // alloc decreases from util ema increse
      spAlloc4 = await feeRouter.spAllocFrac()
      assert.isTrue(spAlloc4.lt(spAlloc3))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // **decrease** SP deposit
      await stabilityPool.withdrawFromSP(startSp.mul(toBN('2')), { from: whale })

      // Drip
      tx5 = await troveManager.drip()
      toSP5 = toBN(th.getRawEventArgByName(tx5, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      assert.isTrue(toSP5.lt(toSP4))

      // utilization ema *decreases*
      spUtil5 = await feeRouter.spUtilizationEma()
      assert.isTrue(spUtil5.lt(spUtil4))

      // alloc increases from util ema decraese
      spAlloc5 = await feeRouter.spAllocFrac()
      assert.isTrue(spAlloc5.gt(spAlloc4))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // Drip
      tx6 = await troveManager.drip()
      toSP6 = toBN(th.getRawEventArgByName(tx6, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      assert.isTrue(toSP6.gt(toSP5))

      // utilization ema *decreases*
      spUtil6 = await feeRouter.spUtilizationEma()
      assert.isTrue(spUtil6.lt(spUtil5))

      // alloc increases from util ema decraese
      spAlloc6 = await feeRouter.spAllocFrac()
      assert.isTrue(spAlloc6.gt(spAlloc5))

  })
  it('getCurrentValue(): reports correct values', async () => {
      // get ema outside of dead band, ensure integral accumulates
      // get ema inside of dead bande, ensure integral doesn't accumulate and output=bias +kp*0 + ki*integral
      //
      //
      // create 2000 debt
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await feeRouter.errorDeadband()

      // create utilization of target + deadband
      newUtil = (await feeRouter.targetSpUtil()).add(deadBand.mul(toBN('1')))
      newDeposit = newUtil.mul(entireDebt).div(toBN(dec(1,18)))
      await fakeIncreaseSPDeposits(newDeposit)

      // get spot value of LP/debt
      currentValue = await feeRouter.getCurrentValue()
      assert.isTrue(currentValue.eq(newUtil))

      // zero sp util
      await fakeResetSPDeposits()

      // get spot value of LP/debt
      currentValue = await feeRouter.getCurrentValue()
      assert.isTrue(currentValue.eq(toBN(0)))
  })
  it('getCurrentValue(): reports ema when zero debt', async () => {
      currentValue = await feeRouter.getCurrentValue()
      assert.isTrue(currentValue.eq(await feeRouter.spUtilizationEma()))
  })

  it('updateAllocation(): allocation accumulates as expected when ema error outside of deadband', async () => {
      // get ema outside of dead band, ensure integral accumulates
      // get ema inside of dead bande, ensure integral doesn't accumulate and output=bias +kp*0 + ki*integral
      //
      //
      origEma = await feeRouter.spUtilizationEma()
      origAlloc = await feeRouter.spAllocFrac()

      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await feeRouter.errorDeadband()

      // set new SP utilization=target + 3*deadband(too much sp deposits)
      // this should create EMA w/ negative error larget than deadband and reduce spAllocFrac
      newUtil = (await feeRouter.targetSpUtil()).add(deadBand.mul(toBN('3')))
      newDeposit = newUtil.mul(entireDebt).div(toBN(dec(1,18)))

      await fakeIncreaseSPDeposits(newDeposit)

      currentValue = await feeRouter.getCurrentValue()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      newAlloc = await feeRouter.spAllocFrac()

      // ensure error is outside of deadband
      error = (await feeRouter.targetSpUtil()).sub(await feeRouter.spUtilizationEma())
      assert.isTrue(error.lt((await feeRouter.errorDeadband()).mul(toBN('-1'))))

      // ensure output didn't hit bound, which would not accumulate integral
      assert.isFalse(newAlloc.eq(await feeRouter.MIN_ALLOCATION_FRAC()))
      assert.isFalse(newAlloc.eq(await feeRouter.MAX_ALLOCATION_FRAC()))
      assert.isFalse(origAlloc.eq(newAlloc))
      assert.isTrue(origAlloc.gt(newAlloc))

      const pendingDeposits = await contracts.stabilityPool.pendingLUSDDeposits()
      const balance = (await contracts.lusdToken.balanceOf(contracts.stabilityPool.address)).add(pendingDeposits)

  })
  it('updateAllocation(): output expected when ema error outside of deadband', async () => {
      deadBand = await feeRouter.errorDeadband()

      startAlloc = await feeRouter.spAllocFrac()
      // open a trove 
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 
      entireDebt = await aggregator.getEntireSystemDebt()

      // set new SP utilization=target + 3*deadband(too much sp deposits)
      // this should create EMA w/ negative error larger than deadband and reduce spAllocFrac
      newUtil = (await feeRouter.targetSpUtil()).add(deadBand.mul(toBN('3')))
      newDeposit = newUtil.mul(entireDebt).div(toBN(dec(1,18)))
      await fakeIncreaseSPDeposits(newDeposit)

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      newAlloc = await feeRouter.spAllocFrac()
      newIntegral = await feeRouter.controlIntegral()

      // ensure error is outside of deadband
      error = (await feeRouter.targetSpUtil()).sub(await feeRouter.spUtilizationEma())
      assert.isTrue(error.lt((await feeRouter.errorDeadband()).mul(toBN('-1'))))

      bias = await feeRouter.SP_BIAS_FRAC()
      pOutput = (await feeRouter.kp()).mul(error).div(toBN(dec(1,18)))
      iOutput = (await feeRouter.ki()).mul(newIntegral).div(toBN(dec(1,18)))

      totalOutput = bias.add(pOutput).add(iOutput)
      assert.isTrue(newAlloc.eq(totalOutput))

      assert.isTrue(newAlloc.lt(startAlloc))

  })
  it('updateAllocation(): allocation does not change when ema error inside of deadband', async () => {

      origEma = await feeRouter.spUtilizationEma()
      origIntegral = await feeRouter.controlIntegral()
      origAlloc = await feeRouter.spAllocFrac()
      assert.isTrue(origIntegral.eq(toBN('0')))

      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await feeRouter.errorDeadband()

      // set new SP utilization=target + 1*deadband(too much sp deposits)
      // this should keep EMA within deadband
      newUtil = (await feeRouter.targetSpUtil()).add(deadBand.mul(toBN('1')))
      newDeposit = newUtil.mul(entireDebt).div(toBN(dec(1,18)))
      await fakeIncreaseSPDeposits(newDeposit)

      currentValue = await feeRouter.getCurrentValue()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      newIntegral = await feeRouter.controlIntegral()
      newEma = await feeRouter.spUtilizationEma()

      // new ema=50% of old ema + 50% of current value
      th.assertIsApproximatelyEqual(await feeRouter.spUtilizationEma(), origEma.div(toBN('2')).add(newUtil.div(toBN('2'))))

      // ensure error is inside of deadband
      error = (await feeRouter.targetSpUtil()).sub(await feeRouter.spUtilizationEma())
      assert.isTrue(error.gt((await feeRouter.errorDeadband()).mul(toBN('-1'))))

      // get control output
      newAlloc = await feeRouter.spAllocFrac()

      // ensure output didn't hit bound, which would not accumulate integral
      assert.isFalse(newAlloc.eq(await feeRouter.MIN_ALLOCATION_FRAC()))
      assert.isFalse(newAlloc.eq(await feeRouter.MAX_ALLOCATION_FRAC()))
      assert.isTrue(origIntegral.eq(newIntegral))

      bias = await feeRouter.SP_BIAS_FRAC()
      iOutput = (await feeRouter.ki()).mul(newIntegral).div(toBN(dec(1,18)))

      // error is within deadband so becomes zero in PI output calculation
      totalOutput = bias.add(iOutput)

      assert.isTrue(newAlloc.eq(totalOutput))
      assert.isTrue(newAlloc.eq(origAlloc))

  })
  it('updateAllocation(): output expected when ema error inside of deadband', async () => {
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await feeRouter.errorDeadband()

      // set new SP utilization=target + 1*deadband(too much sp deposits)
      // this should keep EMA within deadband
      newUtil = (await feeRouter.targetSpUtil()).add(deadBand.mul(toBN('1')))
      newDeposit = newUtil.mul(entireDebt).div(toBN(dec(1,18)))
      await fakeIncreaseSPDeposits(newDeposit)

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      newIntegral = await feeRouter.controlIntegral()

      // ensure error is inside of deadband
      error = (await feeRouter.targetSpUtil()).sub(await feeRouter.spUtilizationEma())
      assert.isTrue(error.gt((await feeRouter.errorDeadband()).mul(toBN('-1'))))

      // get control output
      spAllocFrac = await feeRouter.spAllocFrac()

      bias = await feeRouter.SP_BIAS_FRAC()
      iOutput = (await feeRouter.ki()).mul(newIntegral).div(toBN(dec(1,18)))

      // error is within deadband so pOutput is zero in PI output calculation
      totalOutput = bias.add(iOutput)
      assert.isTrue(spAllocFrac.eq(totalOutput))
  })
  it('updateAllocation(): SP allocation reaches max when SP utilization is zero', async () => {
      // create some debt, so SP util can be 0
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      // start with no SP deposits

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      // After a zero reading after half-life, ema should now be 1/2 * initial value of targetSpUtil
      ema = await feeRouter.spUtilizationEma()
      assert.isTrue(ema.mul(toBN(2)).eq(await feeRouter.targetSpUtil()))

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      // After a second zero reading after half-life, ema should now be 1/4 * initial value of targetSpUtil
      ema = await feeRouter.spUtilizationEma()
      assert.isTrue(ema.mul(toBN(4)).eq(await feeRouter.targetSpUtil()))

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      // After a third zero reading after half-life, ema should now be 1/8 * initial value of targetSpUtil
      ema = await feeRouter.spUtilizationEma()
      assert.isTrue(ema.mul(toBN(8)).eq(await feeRouter.targetSpUtil()))

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()
      spAllocFrac = await feeRouter.spAllocFrac()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()
      spAllocFrac = await feeRouter.spAllocFrac()

      assert.isTrue(spAllocFrac.eq(await feeRouter.MAX_ALLOCATION_FRAC()))

  })
  it('updateAllocation(): SP allocation reaches min when SP utilization is high', async () => {
      const { collateral: B_coll , netDebt: B_netDebt} = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      // deposit all debt in SP
      await fakeIncreaseSPDeposits(B_netDebt)

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await feeRouter.HALFLIFE(), web3.currentProvider)
      await feeRouter.updateAllocation()

      // get control output
      spAllocFrac = await feeRouter.spAllocFrac()
      assert.isTrue(spAllocFrac.eq(await feeRouter.MIN_ALLOCATION_FRAC()))
  })

  it('allocateFees(): fees are split between SP and global router', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: dec(1, 23), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })

      // provide to SP so interest is dripped
      await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: bob })

      spDepositsBefore = await lusdToken.balanceOf(lqtyStaking.address)

      // fastforward 1 half-life
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

      tx = await troveManager.drip()

      // FeeRouter values
      toSP = toBN(th.getRawEventArgByName(tx, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      remaining = toBN(th.getRawEventArgByName(tx, feeRouterInterface, feeRouter.address, "Drip", "_remaining"));
      totalFees = toSP.add(remaining)

      // GlobalFeeRouter values
      toLP = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));
      toOracle = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toOracle"));
      toStaking = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking"));

      assert.isTrue(remaining.gt(toBN('0')))
      assert.isTrue(remaining.eq(toLP.add(toOracle).add(toStaking)))

      assert.isTrue(totalFees.eq(toSP.add(toLP).add(toOracle).add(toStaking)))


      spAllocFrac = await feeRouter.spAllocFrac()
      lpAllocFrac = await globalFeeRouter.lpAllocFrac()

      // fastforward far enough to ensure toLP and toStaking are non-zero
      freq  = await globalFeeRouter.distributionFreq()
      await th.fastForwardTime(freq,  web3.currentProvider)

      tx = await troveManager.drip()

      // FeeRouter values
      toSP = toBN(th.getRawEventArgByName(tx, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"));
      remaining = toBN(th.getRawEventArgByName(tx, feeRouterInterface, feeRouter.address, "Drip", "_remaining"));
      totalFees = toSP.add(remaining)

      // GlobalFeeRouter values
      toLP = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));
      toOracle = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toOracle"));
      toStaking = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking"));

      assert.isTrue(remaining.gt(toBN('0')))
      assert.isTrue(remaining.eq(toLP.add(toOracle).add(toStaking)))

      assert.isTrue(totalFees.eq(toSP.add(toLP).add(toOracle).add(toStaking)))


      // Now check individual allocations against Router allocations
      assert.isTrue(toSP.eq(totalFees.mul(spAllocFrac).div(toBN(dec(1,18)))))
      expLP = totalFees.mul(lpAllocFrac).div(toBN(dec(1,18)))

      // LP allocation frac takes entire remaining
      assert.isTrue(expLP.gt(remaining)) 
      assert.isTrue(toLP.eq(remaining))
  })
})

contract('Reset chain state', async accounts => { })
