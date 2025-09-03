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

  it('lpUtilizationEma(): fees to LP decrease if lp utilization goes up', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: carol } })

      whaleDebt = toBN(dec(16, 20))
      await openTrove({ ICR: toBN(dec(20, 18)), extraLUSDAmount: whaleDebt, extraParams: { from: whale } })
      await stabilityPool.provideToSP(whaleDebt, ZERO_ADDRESS, { from: whale })

      // set starting liquidity to create utilization=target utilization
      startLiquidity = (await globalFeeRouter.targetLpUtil()).mul(await aggregator.getEntireSystemDebt()).div(toBN(dec(1,18)))
      await marketOracle.setRDLiquidity(startLiquidity)

      // topoff oracle so it doesn't need payments for this test
      // 
      await lusdToken.transfer(marketOracle.address, await globalFeeRouter.oracleMinBalance(), {from: alice})

      lpAlloc = await globalFeeRouter.lpAllocFrac()
      lpUtil = await globalFeeRouter.lpUtilizationEma()

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // DRIP 
      tx1 = await troveManager.drip() 
      // fees to LPs
      toLP1 = toBN(th.getRawEventArgByName(tx1, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));

      // new utilization ema
      lpUtil1 = await globalFeeRouter.lpUtilizationEma()

      // utilization drops slightly from debt accrual
      assert.isTrue(lpUtil1.lt(lpUtil))

      // allocation is calculated *after* fees are distributed and new ema is calculated
      lpAlloc1 = await globalFeeRouter.lpAllocFrac()

      // utilization has only changed slightly from interest accrual and is still within deadband
      // so alloc is unchanged
      assert.isTrue(lpAlloc1.eq(lpAlloc))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // increase liquidity/debt ratio
      // Next drip uses existing allocation so this won't take affect until tx3
      await marketOracle.setRDLiquidity(startLiquidity.mul(toBN('3')))

      // DRIP 
      tx2 = await troveManager.drip()
      toLP2 = toBN(th.getRawEventArgByName(tx2, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));

      // utilization ema increases
      lpUtil2 = await globalFeeRouter.lpUtilizationEma()
      assert.isTrue(lpUtil2.gt(lpUtil1))

      // allocation decreases as utilization has increased
      lpAlloc2 = await globalFeeRouter.lpAllocFrac()
      assert.isTrue(lpAlloc2.lt(lpAlloc1))
      
      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // increase liquidity/debt ratio
      await marketOracle.setRDLiquidity(startLiquidity.mul(toBN('3')))

      // DRIP 
      tx3 = await troveManager.drip()
      toLP3 = toBN(th.getRawEventArgByName(tx3, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));

      // tx3 uses existing lpAlloc2 to distribute fees, so increased utilization finally takes effect
      assert.isTrue(toLP3.lt(toLP2))

      // utilization ema increases
      lpUtil3 = await globalFeeRouter.lpUtilizationEma()
      assert.isTrue(lpUtil3.gt(lpUtil2))

      // allocation decreases as utilization has increased
      lpAlloc3 = await globalFeeRouter.lpAllocFrac()
      assert.isTrue(lpAlloc3.lt(lpAlloc2))

      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // increase liquidity
      await marketOracle.setRDLiquidity(startLiquidity.mul(toBN('4')))

      // DRIP 
      tx4 = await troveManager.drip()
      toLP4 = toBN(th.getRawEventArgByName(tx4, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));
      assert.isTrue(toLP4.lt(toLP3))

      // utilization ema increases
      lpUtil4 = await globalFeeRouter.lpUtilizationEma()
      assert.isTrue(lpUtil4.gt(lpUtil3))

      // allocation decreases as utilization has increased
      lpAlloc4 = await globalFeeRouter.lpAllocFrac()
      assert.isTrue(lpAlloc4.lt(lpAlloc3))


      // fast-forward
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK, web3.currentProvider)

      // *decrease* liquidity, won't take effect until tx6
      await marketOracle.setRDLiquidity(startLiquidity.mul(toBN('0')))

      // DRIP 
      tx5 = await troveManager.drip()
      toLP5 = toBN(th.getRawEventArgByName(tx5, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));
      // still decreasing distribution since drip uses existing allocation
      assert.isTrue(toLP5.lt(toLP4))

      // utilization ema decreases
      lpUtil5 = await globalFeeRouter.lpUtilizationEma()
      assert.isTrue(lpUtil5.lt(lpUtil4))

      // allocation *increases* as utilization has decreased
      lpAlloc5 = await globalFeeRouter.lpAllocFrac()
      assert.isTrue(lpAlloc5.gt(lpAlloc4))

  })
  it('getCurrentValue(): reports correct values', async () => {
      // get ema outside of dead band, ensure integral accumulates
      // get ema inside of dead bande, ensure integral doesn't accumulate and output=bias +kp*0 + ki*integral
      //
      //
      // create 2000 debt
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()

      // create utilization of target + deadband
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('1')))
      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      // get spot value of LP/debt
      currentValue = await globalFeeRouter.getCurrentValue()
      assert.isTrue(currentValue.eq(newUtil))

      // zero liquidity util
      newUtil = toBN('0')
      await marketOracle.setRDLiquidity(toBN('0'))

      // get spot value of LP/debt
      currentValue = await globalFeeRouter.getCurrentValue()
      assert.isTrue(currentValue.eq(newUtil))
  })
  it('getCurrentValue(): reports ema when zero debt', async () => {
      currentValue = await globalFeeRouter.getCurrentValue()
      assert.isTrue(currentValue.eq(await globalFeeRouter.lpUtilizationEma()))
  })

  it('updateAllocation(): allocation accumulates as expected when ema error outside of deadband', async () => {
      // get ema outside of dead band, ensure integral accumulates
      // get ema inside of dead bande, ensure integral doesn't accumulate and output=bias +kp*0 + ki*integral
      //
      //
      origEma = await globalFeeRouter.lpUtilizationEma()
      origAlloc = await globalFeeRouter.lpAllocFrac()

      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()

      // set new LP utilization=target + 3*deadband(too much liquidity)
      // this should create EMA w/ negative error larget than deadband and reduce lpAllocFrac
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('3')))

      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      currentValue = await globalFeeRouter.getCurrentValue()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await globalFeeRouter.HALFLIFE(), web3.currentProvider)
      await globalFeeRouter.updateAllocation(false)

      newAlloc = await globalFeeRouter.lpAllocFrac()

      // ensure error is outside of deadband
      error = (await globalFeeRouter.targetLpUtil()).sub(await globalFeeRouter.lpUtilizationEma())
      assert.isTrue(error.lt((await globalFeeRouter.errorDeadband()).mul(toBN('-1'))))

      // ensure output didn't hit bound, which would not accumulate integral
      assert.isFalse(newAlloc.eq(await globalFeeRouter.MIN_ALLOCATION_FRAC()))
      assert.isFalse(newAlloc.eq(await globalFeeRouter.MAX_ALLOCATION_FRAC()))
      assert.isFalse(origAlloc.eq(newAlloc))
      assert.isTrue(origAlloc.gt(newAlloc))

  })
  it('updateAllocation(): output expected when ema error outside of deadband', async () => {
      deadBand = await globalFeeRouter.errorDeadband()

      startAlloc = await globalFeeRouter.lpAllocFrac()
      // open a trove 
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 
      entireDebt = await aggregator.getEntireSystemDebt()

      // set new LP utilization=target + 3*deadband(too much liquidity)
      // this should create EMA w/ negative error larger than deadband and reduce lpAllocFrac
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('3')))
      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await globalFeeRouter.HALFLIFE(), web3.currentProvider)
      await globalFeeRouter.updateAllocation(false)

      newAlloc = await globalFeeRouter.lpAllocFrac()
      newIntegral = await globalFeeRouter.controlIntegral()

      // ensure error is outside of deadband
      error = (await globalFeeRouter.targetLpUtil()).sub(await globalFeeRouter.lpUtilizationEma())
      assert.isTrue(error.lt((await globalFeeRouter.errorDeadband()).mul(toBN('-1'))))

      bias = await globalFeeRouter.LP_BIAS_FRAC()
      pOutput = (await globalFeeRouter.kp()).mul(error).div(toBN(dec(1,18)))
      iOutput = (await globalFeeRouter.ki()).mul(newIntegral).div(toBN(dec(1,18)))

      totalOutput = bias.add(pOutput).add(iOutput)
      assert.isTrue(newAlloc.eq(totalOutput))


      assert.isTrue(newAlloc.lt(startAlloc))

  })
  it('updateAllocation(): allocation does not change when ema error inside of deadband', async () => {

      origEma = await globalFeeRouter.lpUtilizationEma()
      origIntegral = await globalFeeRouter.controlIntegral()
      origAlloc = await globalFeeRouter.lpAllocFrac()
      assert.isTrue(origIntegral.eq(toBN('0')))

      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()

      // set new LP utilization=target + 1*deadband(too much liquidity)
      // this should keep EMA within deadband
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('1')))

      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      currentValue = await globalFeeRouter.getCurrentValue()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await globalFeeRouter.HALFLIFE(), web3.currentProvider)
      await globalFeeRouter.updateAllocation(false)

      newIntegral = await globalFeeRouter.controlIntegral()
      newEma = await globalFeeRouter.lpUtilizationEma()

      // new ema=50% of old ema + 50% of current value
      th.assertIsApproximatelyEqual(await globalFeeRouter.lpUtilizationEma(), origEma.div(toBN('2')).add(newUtil.div(toBN('2'))))

      // ensure error is inside of deadband
      error = (await globalFeeRouter.targetLpUtil()).sub(await globalFeeRouter.lpUtilizationEma())
      assert.isTrue(error.gt((await globalFeeRouter.errorDeadband()).mul(toBN('-1'))))

      // get control output
      newAlloc = await globalFeeRouter.lpAllocFrac()

      // ensure output didn't hit bound, which would not accumulate integral
      assert.isFalse(newAlloc.eq(await globalFeeRouter.MIN_ALLOCATION_FRAC()))
      assert.isFalse(newAlloc.eq(await globalFeeRouter.MAX_ALLOCATION_FRAC()))
      assert.isTrue(origIntegral.eq(newIntegral))

      bias = await globalFeeRouter.LP_BIAS_FRAC()
      iOutput = (await globalFeeRouter.ki()).mul(newIntegral).div(toBN(dec(1,18)))

      // error is within deadband so becomes zero in PI output calculation
      totalOutput = bias.add(iOutput)

      assert.isTrue(newAlloc.eq(totalOutput))
      assert.isTrue(newAlloc.eq(origAlloc))

  })
  it('updateAllocation(): output expected when ema error inside of deadband', async () => {
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()

      // set new LP utilization=target + 1*deadband(too much liquidity)
      // this should keep EMA within deadband
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('1')))

      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await globalFeeRouter.HALFLIFE(), web3.currentProvider)
      await globalFeeRouter.updateAllocation(false)

      newIntegral = await globalFeeRouter.controlIntegral()

      // ensure error is inside of deadband
      error = (await globalFeeRouter.targetLpUtil()).sub(await globalFeeRouter.lpUtilizationEma())
      assert.isTrue(error.gt((await globalFeeRouter.errorDeadband()).mul(toBN('-1'))))

      // get control output
      lpAllocFrac = await globalFeeRouter.lpAllocFrac()

      bias = await globalFeeRouter.LP_BIAS_FRAC()
      iOutput = (await globalFeeRouter.ki()).mul(newIntegral).div(toBN(dec(1,18)))

      // error is within deadband so pOutput is zero in PI output calculation
      totalOutput = bias.add(iOutput)
      assert.isTrue(lpAllocFrac.eq(totalOutput))
  })
  it('updateAllocation(): integral doesnt accumulate when cap is active and utilization under target', async () => {
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()

      // set utilization = 0 will
      // 1. be large enough, outside dead band so error !=0 and we can see prevError be changed when capReached
      // and
      // 2. be a *positive* error, so it drives controller to go even higher when capReached
      newUtil = toBN('0')

      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      oldIntegral = await globalFeeRouter.controlIntegral()
      oldTs = await globalFeeRouter.controlLastUpdate()
      oldPrevError = await globalFeeRouter.controlPrevError()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await globalFeeRouter.HALFLIFE(), web3.currentProvider)
      await globalFeeRouter.updateAllocation(true)

      newIntegral = await globalFeeRouter.controlIntegral()
      newTs = await globalFeeRouter.controlLastUpdate()
      newPrevError = await globalFeeRouter.controlPrevError()

      // integral is unchanged
      assert.isTrue(newIntegral.eq(oldIntegral))

      // but prevError and timestamp have changed
      assert.isTrue(newTs.gt(oldTs))
      assert.isFalse(newPrevError.eq(oldPrevError))

  })
  it('updateAllocation(): integral does accumulate when cap is active but utilization above target', async () => {
      const { collateral: B_coll } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: bob } }) 

      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()

      // set new LP utilization=target + 3*deadband(too much liquidity)
      // this is
      // 1. outside of deadband
      // and
      // 3. a negative error, which shouldn't stop integral accumulation
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('3')))

      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      oldIntegral = await globalFeeRouter.controlIntegral()
      oldTs = await globalFeeRouter.controlLastUpdate()
      oldPrevError = await globalFeeRouter.controlPrevError()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(await globalFeeRouter.HALFLIFE(), web3.currentProvider)
      await globalFeeRouter.updateAllocation(true)

      newIntegral = await globalFeeRouter.controlIntegral()
      newTs = await globalFeeRouter.controlLastUpdate()
      newPrevError = await globalFeeRouter.controlPrevError()

      // integral changes
      assert.isFalse(newIntegral.eq(oldIntegral))

      // prevError and timestamp have changed
      assert.isTrue(newTs.gt(oldTs))
      assert.isFalse(newPrevError.eq(oldPrevError))

  })
  it('splitOracleAndRemaining(): all fees go to oracle when fee amount less than oracle target - oracle min', async () => {
      oracleTargetBalance = await globalFeeRouter.oracleTargetBalance()
      oracleMinBalance = await globalFeeRouter.oracleMinBalance()

      oracleBalanceBefore = await lusdToken.balanceOf(marketOracle.address)

      amount = dec(500, 18)
      const {0: toOracle, 1: toStaking} = await globalFeeRouter.splitOracleAndRemaining(amount)

      assert.isTrue(toOracle.gt(toBN('0')))
      assert.isTrue(toStaking.eq(toBN('0')))

      // oracle uses up whatever it takes to get to target balance.
      // if this value is less than fee, the oracle gets everything
      assert.isTrue(toOracle.lt(oracleTargetBalance.sub(oracleBalanceBefore)))

  })
  it('splitOracleAndRemaining(): no fees go to oracle when oracle balance > oracle min', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

      oracleMinBalance = await globalFeeRouter.oracleMinBalance()
      await lusdToken.transfer(marketOracle.address, await globalFeeRouter.oracleMinBalance(), {from: alice})

      amount = toBN(dec(500, 18))
      const {0: toOracle, 1: toStaking} = await globalFeeRouter.splitOracleAndRemaining(amount)

      assert.isTrue(toOracle.eq(toBN('0')))
      assert.isTrue(toStaking.eq(amount))

  })
  it('splitOracleAndRemaining(): fees go to oracle and stakers when oracle needs top-up and amount > oracle_target - oracle_balance', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })

      oracleTargetBalance = await globalFeeRouter.oracleTargetBalance()
      oracleMinBalance = await globalFeeRouter.oracleMinBalance()

      // oracle has less than min balance
      await lusdToken.transfer(marketOracle.address, toBN(dec(100,18)), {from: alice})

      oracleBalanceBefore = await lusdToken.balanceOf(marketOracle.address)

      // amount is more than needed to top-up oracle
      amount = toBN(dec(1000, 18))
      const {0: toOracle, 1: toStaking} = await globalFeeRouter.splitOracleAndRemaining(amount)

      assert.isTrue(toOracle.eq(oracleTargetBalance.sub(oracleBalanceBefore)))
      assert.isTrue(toStaking.eq(amount.sub((oracleTargetBalance.sub(oracleBalanceBefore)))))

  })
  it('allocateFees(): LPs and stakers get no fees when total fees is less than oracle target - oracle min', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: dec(1, 23), extraParams: { from: alice } })
      //await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })

      // provide to SP so interest is dripped
      await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: alice })

      oracleTargetBalance = await globalFeeRouter.oracleTargetBalance()
      oracleMinBalance = await globalFeeRouter.oracleMinBalance()

      oracleBalanceBefore = await lusdToken.balanceOf(marketOracle.address)
      assert.isTrue(oracleBalanceBefore.lt(oracleMinBalance))
      oracleNeeded = oracleTargetBalance.sub(oracleBalanceBefore)
      lpBalanceBefore = await lusdToken.balanceOf(lpStaking.address)
      stakingBalanceBefore = await lusdToken.balanceOf(lqtyStaking.address)

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

      tx = await troveManager.drip()

      toOracle = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toOracle"));
      toLP = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));
      toStaking = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking"));

      // oracle payment is less than needed
      assert.isTrue(toOracle.lt(oracleNeeded))
      assert.isTrue(toOracle.gt(toBN('0')))

      // LPs and staking gets nothing
      assert.isTrue(toLP.eq(toBN('0')))
      assert.isTrue(toStaking.eq(toBN('0')))

      oracleBalanceAfter = await lusdToken.balanceOf(marketOracle.address)
      lpBalanceAfter = await lusdToken.balanceOf(lpStaking.address)
      stakingBalanceAfter = await lusdToken.balanceOf(lqtyStaking.address)

      // ensure oracle received exact value from log
      assert.isTrue(toOracle.eq(oracleBalanceAfter.sub(oracleBalanceBefore)))
      // ensure LP and staking balances are unchanged
      assert.isTrue(toLP.eq(lpBalanceAfter.sub(lpBalanceBefore)))
      assert.isTrue(toStaking.eq(stakingBalanceAfter.sub(stakingBalanceBefore)))

  })

  it('allocateFees(): LPs get some fees when total fees is greater than oracle target - oracle min', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: dec(1, 23), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })

      // provide to SP so interest is dripped
      await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: bob })

      oracleTargetBalance = await globalFeeRouter.oracleTargetBalance()
      oracleMinBalance = await globalFeeRouter.oracleMinBalance()

      oracleBalanceBefore = await lusdToken.balanceOf(marketOracle.address)
      assert.isTrue(oracleBalanceBefore.lt(oracleMinBalance))
      oracleNeeded = oracleTargetBalance.sub(oracleBalanceBefore)
      lpBalanceBefore = await lusdToken.balanceOf(lpStaking.address)
      stakingBalanceBefore = await lusdToken.balanceOf(lqtyStaking.address)

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(10*timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)

      tx = await troveManager.drip()

      toOracle = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toOracle"));
      toLP = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toLP"));
      toStaking = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking"));

      // oracle payment is full
      assert.isTrue(toOracle.eq(oracleNeeded))
      assert.isTrue(toOracle.gt(toBN('0')))

      // LPs gets something
      assert.isTrue(toLP.gt(toBN('0')))

      oracleBalanceAfter = await lusdToken.balanceOf(marketOracle.address)
      lpBalanceAfter = await lusdToken.balanceOf(lpStaking.address)

      // ensure oracle received exact value from log
      assert.isTrue(toOracle.eq(oracleBalanceAfter.sub(oracleBalanceBefore)))
      // ensure LP balance has changed
      assert.isTrue(toLP.eq(lpBalanceAfter.sub(lpBalanceBefore)))

  })
  it('allocateFees(): integral doesnt accumulate when output,toLP, is greater than available,toLPAndStaking, and error would push toLP higher', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: dec(1, 23), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })

      // provide to SP so interest is dripped
      await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: bob })

      oracleTargetBalance = await globalFeeRouter.oracleTargetBalance()
      oracleMinBalance = await globalFeeRouter.oracleMinBalance()

      oracleBalanceBefore = await lusdToken.balanceOf(marketOracle.address)
      assert.isTrue(oracleBalanceBefore.lt(oracleMinBalance))
      oracleNeeded = oracleTargetBalance.sub(oracleBalanceBefore)
      lpBalanceBefore = await lusdToken.balanceOf(lpStaking.address)
      stakingBalanceBefore = await lusdToken.balanceOf(lqtyStaking.address)

      spAllocFrac = await feeRouter.spAllocFrac()
      lpAllocFrac = await globalFeeRouter.lpAllocFrac()
      allocSum = spAllocFrac.add(lpAllocFrac)

      // keep timetraveling to get to the point of LP controller saturation(sum of both allocs > 100%)
      while (allocSum.lt(toBN(dec(1,18)))) {
          await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider)
          tx = await troveManager.drip()
          spAllocFrac = await feeRouter.spAllocFrac()
          lpAllocFrac = await globalFeeRouter.lpAllocFrac()
          allocSum = spAllocFrac.add(lpAllocFrac)

      }

      // ensure the sum of allocations is over 100%
      // onyl in this case will globalFeeRouter try to allocate more to LP than is available. aka capReached
      assert.isTrue(spAllocFrac.add(lpAllocFrac).gte(toBN(dec(1,18))))

      oldIntegral = await globalFeeRouter.controlIntegral()
      oldTs = await globalFeeRouter.controlLastUpdate()
      oldPrevError = await globalFeeRouter.controlPrevError()

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(10*timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      tx = await troveManager.drip()

      newIntegral = await globalFeeRouter.controlIntegral()
      newTs = await globalFeeRouter.controlLastUpdate()
      newPrevError = await globalFeeRouter.controlPrevError()

      // integral is unchanged
      assert.isTrue(newIntegral.eq(oldIntegral))

      // but prevError and timestamp have changed
      assert.isTrue(newTs.gt(oldTs))
      assert.isFalse(newPrevError.eq(oldPrevError))
  })
  it('allocateFees(): integral does accumulate when output,toLP, is greater than available,toLPAndStaking, but error would push toLP lower', async () => {
      await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: dec(1, 23), extraParams: { from: alice } })
      await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })

      // provide to SP so interest is dripped
      await stabilityPool.provideToSP(dec(100, 18), ZERO_ADDRESS, { from: bob })

      oracleTargetBalance = await globalFeeRouter.oracleTargetBalance()
      oracleMinBalance = await globalFeeRouter.oracleMinBalance()

      oracleBalanceBefore = await lusdToken.balanceOf(marketOracle.address)
      assert.isTrue(oracleBalanceBefore.lt(oracleMinBalance))
      oracleNeeded = oracleTargetBalance.sub(oracleBalanceBefore)
      lpBalanceBefore = await lusdToken.balanceOf(lpStaking.address)
      stakingBalanceBefore = await lusdToken.balanceOf(lqtyStaking.address)

      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(10*timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
      tx = await troveManager.drip()

      spAllocFrac = await feeRouter.spAllocFrac()
      lpAllocFrac = await globalFeeRouter.lpAllocFrac()

      // ensure the sum of allocations is over 100%
      // onyl in this case will globalFeeRouter try to allocate more to LP than is available. aka capReached
      assert.isTrue(spAllocFrac.add(lpAllocFrac).gt(toBN(dec(1,18))))


      // fastforward 1 half-life and update allocation
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider)

      oldIntegral = await globalFeeRouter.controlIntegral()
      oldTs = await globalFeeRouter.controlLastUpdate()
      oldPrevError = await globalFeeRouter.controlPrevError()

      // create large enough over-utilization(outside deadband), so while current lpAllocFrac has hit upper bound
      // and toLP will be gt toLPAndStaking, the current error(over-utilization) will be in the opposite
      // direction of the saturation
      entireDebt = await aggregator.getEntireSystemDebt()
      deadBand = await globalFeeRouter.errorDeadband()
      newUtil = (await globalFeeRouter.targetLpUtil()).add(deadBand.mul(toBN('4')))
      await marketOracle.setRDLiquidity(newUtil.mul(entireDebt).div(toBN(dec(1,18))))

      tx = await troveManager.drip()
      toStaking = toBN(th.getRawEventArgByName(tx, globalFeeRouterInterface, globalFeeRouter.address, "GlobalDrip", "_toStaking"));

      // Ensure staking as nothing left. aka toLP = toLPAndStaking
      assert.isTrue(toStaking.eq(toBN('0')))

      // we set spot over-utilization, above but error is based on ema, so we 
      // need to check ema shows over-utilization
      util = await globalFeeRouter.lpUtilizationEma()
      assert.isTrue(util.gt((await globalFeeRouter.targetLpUtil()).add(deadBand)))

      newIntegral = await globalFeeRouter.controlIntegral()
      newTs = await globalFeeRouter.controlLastUpdate()
      newPrevError = await globalFeeRouter.controlPrevError()

      // integral is changed
      assert.isFalse(newIntegral.eq(oldIntegral))

      // but prevError and timestamp have changed
      assert.isTrue(newTs.gt(oldTs))
      assert.isFalse(newPrevError.eq(oldPrevError))

  })

})

contract('Reset chain state', async accounts => { })
