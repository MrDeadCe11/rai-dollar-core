const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")

const TroveManagerTester = artifacts.require("TroveManagerTester")
const TroveManagerLib = artifacts.require("./Dependencies/TroveManagerLib.sol")
const LiquidationsTester = artifacts.require("LiquidationsTester")
const LUSDToken = artifacts.require("LUSDToken")
const RateControlTester = artifacts.require("RateControlTester")
const { BigNumber } = require("ethers");

const th = testHelpers.TestHelper
const dec = th.dec
const toBN = th.toBN
const getDifference = th.getDifference
const assertRevert = th.assertRevert
const mv = testHelpers.MoneyValues
const timeValues = testHelpers.TimeValues

const _18_zeros = '000000000000000000'
const ZERO_ADDRESS = th.ZERO_ADDRESS
const ONE_DOLLAR = toBN(dec(1, 18))
const ONE_CENT = toBN(dec(1, 16))
const GAS_PRICE = 10000000



contract('TroveManager - Shutdown', async accounts => {

  const [
    owner,
    alice, bob, carol, dennis, erin, freddy, greta, harry, ida,
    A, B, C, D, E,
    whale, defaulter_1, defaulter_2, defaulter_3, defaulter_4] = accounts;

    const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let nameRegistry
  let activePool
  let stabilityPool
  let defaultPool
  let functionCaller
  let marketOracle
  let borrowerOperations
  let collateralToken
  let relayer
  let rateControl
  let feeRouter
  let collSurplusPool
  let contracts
  let borrowerOperationsInterface
  let stabilityPoolInterface
  let troveManagerInterface
  let feeRouterInterface
  let collSurplusPoolInterface
  let liquidationsInterface

  let lib;
  
  const getOpenTroveTotalDebt = async (lusdAmount) => th.getOpenTroveTotalDebt(contracts, lusdAmount)
  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const getActualDebtFromComposite = async (compositeDebt) => th.getActualDebtFromComposite(compositeDebt, contracts)
  const getNetBorrowingAmount = async (debtWithFee) => th.getNetBorrowingAmount(contracts, debtWithFee)
  const openTrove = async (params) => th.openTrove(contracts, params)
  const withdrawLUSD = async (params) => th.withdrawLUSD(contracts, params)
  const driveICRToTargetWithPar = async (borrower, targetICR) => th.driveICRToTargetWithPar(contracts, borrower, targetICR)
  const calculateParTarget = async (price, coll, debt, targetICR) => th.calculateParTarget(price, coll, debt, targetICR)

  before(async () => {
    lib = await TroveManagerLib.new();
    await TroveManagerTester.link(lib);
  });
  
  async function setup(){
    contracts = await deploymentHelper.deployLiquityCore()
    contracts.liquidations = await LiquidationsTester.new()
    contracts.troveManager = await TroveManagerTester.new()
    contracts.rateControl = await RateControlTester.new()
    contracts.lusdToken = await LUSDToken.new(
      contracts.troveManager.address,
      contracts.liquidations.address,
      contracts.stabilityPool.address,
      contracts.borrowerOperations.address,
      contracts.globalFeeRouter.address
    )
    const LQTYContracts = await deploymentHelper.deployLQTYContracts(bountyAddress, lpRewardsAddress, multisig)

    priceFeed = contracts.priceFeedTestnet
    await priceFeed.setBorrowerOps(contracts.borrowerOperations.address)
    lusdToken = contracts.lusdToken
    sortedTroves = contracts.sortedTroves
    liquidations = contracts.liquidations
    troveManager = contracts.troveManager
    rewards = contracts.rewards
    nameRegistry = contracts.nameRegistry
    activePool = contracts.activePool
    stabilityPool = contracts.stabilityPool
    defaultPool = contracts.defaultPool
    functionCaller = contracts.functionCaller
    borrowerOperations = contracts.borrowerOperations
    collateralToken = contracts.collateralToken
    relayer = contracts.relayer
    marketOracle = contracts.marketOracleTestnet
    rateControl = contracts.rateControl
    collSurplusPool = contracts.collSurplusPool
    feeRouter = contracts.feeRouter

    feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
    // Interfaces
    stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;
    troveManagerInterface = (await ethers.getContractAt("TroveManager", troveManager.address)).interface;
    feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
    liquidationsInterface = (await ethers.getContractAt("Liquidations", liquidations.address)).interface;
    collSurplusPoolInterface = (await ethers.getContractAt("CollSurplusPool", collSurplusPool.address)).interface;
    borrowerOperationsInterface = (await ethers.getContractAt("BorrowerOperations", borrowerOperations.address)).interface;
    

    await deploymentHelper.connectLQTYContracts(LQTYContracts)
    await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
    await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

    await th.batchMintCollateralTokensAndApproveActivePool(contracts, [owner,
      alice, bob, carol, dennis, erin, freddy, greta, harry, ida,
      A, B, C, D, E,
      whale, defaulter_1, defaulter_2, defaulter_3, defaulter_4], toBN(dec(1000, 26)))
  }

  async function calcSCRPrice() {
  const totalColl = await troveManager.getEntireSystemColl();
  const accRate = await troveManager.accumulatedRate();
  const accShieldRate = await troveManager.accumulatedShieldRate();
  const totalDebt = await troveManager.getEntireSystemDebt(accRate, accShieldRate);
  const par = await relayer.par();
  const SCR = await borrowerOperations.SCR() // 1.10e18
  // price* = SCR * totalDebt * par / (totalColl * 1e18)
  const numerator = SCR.mul(totalDebt).mul(par);
  const denom = totalColl.mul(toBN(dec(1, 18)));
  const scrPrice = numerator.div(denom);
  return scrPrice
  }

  // Adjust each borrower’s debt pre-shutdown to reach icrOpenTarget at pOpen
  async function tuneDebtToICROpen(addr, icrOpenTarget, priceOpen, parOpen) {
    const coll = await th.getTroveEntireColl(contracts, addr);           // includes pending rewards via helper
    const debt = await troveManager.getTroveActualDebt(addr);
    // desiredDebt = coll * priceOpen * 1e18 / (icrOpenTarget * parOpen)
    const desiredDebt = coll.mul(priceOpen).mul(toBN(dec(1,18))).div(icrOpenTarget.mul(parOpen));
    const MIN_NET_DEBT = await borrowerOperations.MIN_NET_DEBT();
    const gasComp = await troveManager.LUSD_GAS_COMPENSATION(); // or use constant if accessible
    const actualDebt = await troveManager.getTroveActualDebt(addr);
    const netDebt = actualDebt.sub(gasComp);
    
    if (debt.gt(desiredDebt)) {
      let delta = debt.sub(desiredDebt);
      const maxRepay = netDebt.sub(MIN_NET_DEBT);
      if (maxRepay.lte(toBN('0'))) return; // can’t repay further without violating min
      if (delta.gt(maxRepay)) delta = maxRepay;
    
      if (delta.gt(toBN('0'))) {
        const { upperHint, lowerHint } = await th.getBorrowerOpsListHint(contracts, coll, debt.sub(delta), /*shielded=*/false);
        await borrowerOperations.repayLUSD(delta, upperHint, lowerHint, { from: addr });
      }
    }
  }

  async function tcrShutdown() {
    const scrPrice = await calcSCRPrice()
    // 1.999% below scr price
    await priceFeed.setPrice(scrPrice)
    await borrowerOperations.shutdown()
    assert.isTrue(await troveManager.isShutdown())
    return scrPrice
  }

  describe('shutdown', async () => {
    beforeEach(async () => {
      await setup()
    })
    it('should shutdown the system when the oracle fails', async () => {
      await priceFeed.setOracleFailure(true)
      await priceFeed.fetchPrice()

      assert.isTrue(await troveManager.isShutdown())
    })

    it('should shutdown the system when the TCR is less than the SCR', async () => {
          // A, B open trove
     await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
     await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })

      await priceFeed.setPrice(toBN(dec(1, 10)))
      await borrowerOperations.shutdown()
      assert.isTrue(await troveManager.isShutdown())
    })

    it('should revert when the TCR is greater than the SCR', async () => {

      try {
        await borrowerOperations.shutdown()
      } catch (err) {
        assert.include(err.message, "TCR must be less than SCR")
      }

      assert.isFalse(await troveManager.isShutdown())
    })

    it('should redeem collateral while tcr < scr', async () => {
      const { collateral: A_coll, debt: A_debt } = await openTrove({ ICR: toBN(dec(400, 16)), extraParams: { from: alice } })
      const { collateral: B_coll, debt: B_debt } = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })
      await relayer.updatePar()
         // skip bootstrapping phase
      await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider)
      await relayer.updatePar()
      //shutdown
      await tcrShutdown()

      const alice_LUSD_before = toBN(await lusdToken.balanceOf(alice))
      const alice_coll_before = toBN(await collateralToken.balanceOf(alice))
      await troveManager.redeemCollateralForShutdown(toBN(dec(100, 18)), '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0, 100, 0, { from: alice })
      const alice_coll_after = toBN(await collateralToken.balanceOf(alice))
      const alice_LUSD_after = toBN(await lusdToken.balanceOf(alice))

      assert.isTrue(alice_LUSD_after.lt(alice_LUSD_before))
      assert.isTrue(alice_coll_before.lt(alice_coll_after))
    })
  })

    describe('liquidations - TCR < SCR', async () => {
      beforeEach(async () => {
        await setup()
      })

      it('liquidate(): closes a Trove that has ICR < MCR', async () => {
        await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    
        const price = await priceFeed.getPrice()
        const ICR_Before = await troveManager.getCurrentICR(alice, price)
    
        assert.equal(dec(1, 18), await relayer.par())
    
        assert.isTrue(ICR_Before.eq(toBN(dec(4, 18))))
    
        const MCR = (await troveManager.MCR()).toString()
        assert.equal(MCR.toString(), '1100000000000000000')

        // Alice increases debt to 180 LUSD, lowering her ICR to 1.11
        const A_LUSDWithdrawal = await getNetBorrowingAmount(dec(130, 18))
    
        const targetICR = toBN('1111111111111111111')
        await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })
    
        const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
        assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)
        // price drops to 1CollateralToken:100LUSD, reducing Alice's ICR below MCR
        // shutdown
        await tcrShutdown()
        
        // await priceFeed.setPrice('100000000000000000000');
        // the tcr should be below ccr to trigger a shutdown
        assert.isTrue(await th.checkRecoveryMode(contracts))
        
        // close Trove
        await liquidations.liquidate(alice, { from: owner });
    
        // check the Trove is successfully closed, and removed from sortedList
        const status = (await troveManager.Troves(alice))[3]
        assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
        const alice_Trove_isInSortedList = await sortedTroves.contains(alice)
        assert.isFalse(alice_Trove_isInSortedList)
    
      })
      it('liquidate(): closes a Trove that has ICR < MCR from par rising', async () => {
        await openTrove({ ICR: toBN(dec(20, 18)), extraParams: { from: whale } })
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
    
        const price = await priceFeed.getPrice()
        const ICR_Before = await troveManager.getCurrentICR(alice, price)
    
        assert.equal(dec(1, 18), await relayer.par())
    
        assert.isTrue(ICR_Before.eq(toBN(dec(4, 18))))
    
        const MCR = (await troveManager.MCR()).toString()
        assert.equal(MCR.toString(), '1100000000000000000')
    
        // Alice increases debt to 180 LUSD, lowering her ICR to 1.11
        const A_LUSDWithdrawal = await getNetBorrowingAmount(dec(130, 18))
    
        const targetICR = toBN('1100000000000000000')
        await withdrawLUSD({ ICR: targetICR, extraParams: { from: alice } })
    
        const ICR_AfterWithdrawal = await troveManager.getCurrentICR(alice, price)
        assert.isAtMost(th.getDifference(ICR_AfterWithdrawal, targetICR), 100)
  

        // ensure it can't be liquidated
        try {
          const txAlice = await liquidations.liquidate(alice)
    
          assert.isFalse(txAlice.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          assert.include(err.message, "Liquidations: nothing to liquidate")
        }

    
        const parBeforeShutdown = await relayer.par()
        //shutdown
        await tcrShutdown()
        // lusd price drops, raising par
        await marketOracle.setPrice(ONE_DOLLAR.sub(ONE_CENT))

        // update par after price drop below ccr
        await relayer.updateRateAndPar(); // initializes lastUpdateTime (no change)
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_HOUR, web3.currentProvider);
        await relayer.updateRateAndPar(); // now par can move up to 0.001 per hour

        const parAfterShutdown = await relayer.par();

        assert.isTrue(parAfterShutdown.gt(parBeforeShutdown), "par should have risen")
        // ICR has dropped
        assert.isTrue(ICR_AfterWithdrawal > await troveManager.getCurrentICR(alice, price));
        const priceNow = await priceFeed.getPrice()
        const icr = await troveManager.getCurrentICR(alice, priceNow)
        const mcr = await troveManager.MCR()
        assert.isTrue(icr.lt(mcr), "ICR must be < MCR at liquidation time")
        const isShutdown = await troveManager.isShutdown()
        assert.isTrue(isShutdown, "system should be shutdown")
        // close Trove
        tx = await liquidations.liquidate(alice, { from: owner });
        /*
        liq_event = tx.logs.find(e => e.event === 'TroveLiqInfo');
        console.log("entireColl", liq_event.args.entireColl.toString())
        console.log("collToLiquidate", liq_event.args.collToLiquidate.toString())
        console.log("collToSp", liq_event.args.collToSp.toString())
        console.log("collToRedistribute", liq_event.args.collToRedistribute.toString())
        */
    
        // check the Trove is successfully closed, and removed from sortedList
        const status = (await troveManager.Troves(alice))[3]
        assert.equal(status, 3)  // status enum 3 corresponds to "Closed by liquidation"
        const alice_Trove_isInSortedList = await sortedTroves.contains(alice)
        assert.isFalse(alice_Trove_isInSortedList)
      })
    
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts", async () => {
        // --- SETUP 
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_Before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_Before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_Before = (await activePool.getLUSDDebt()).toString()
    
        assert.equal(activePool_Collateral_Before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_Before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice’s ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool Collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After= await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        //console.log("activePool_Collateral_After", activePool_Collateral_After.toString())
        //console.log("A_collateral", A_collateral.toString())
        //console.log("B_collateral", B_collateral.toString())
        // TODO Fix off by one
        //assert.equal(activePool_Collateral_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, with liq surplus", async () => {
        // --- SETUP 
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_Before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_Before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_Before = (await activePool.getLUSDDebt()).toString()
    
        //console.log("activePool_RawCollateral_Before", activePool_RawCollateral_Before.toString())
        assert.equal(activePool_Collateral_Before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_Before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1ETH:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice’s ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool Collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        // TODO Fix off by one
        //assert.equal(activePool_ETH_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, with liq surplus", async () => {
        // --- SETUP 
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_Before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_Before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_Before = (await activePool.getLUSDDebt()).toString()
    
        // console.log("activePool_RawCollateral_Before", activePool_RawCollateral_Before.toString())
        // console.log("sum", A_collateral.add(B_collateral).toString())
        assert.equal(activePool_Collateral_Before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_Before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice’s ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool Collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        // TODO Fix off by one
        //assert.equal(activePool_ETH_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
    
      it("liquidate(): decreases ActivePool Collateral and LUSDDebt by correct amounts, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check ActivePool Collateral and LUSD debt before
        const activePool_Collateral_Before = (await activePool.getCollateral()).toString()
        const activePool_RawCollateral_Before = (await collateralToken.balanceOf(activePool.address)).toString()
        const activePool_LUSDDebt_Before = (await activePool.getLUSDDebt()).toString()
    
        assert.equal(activePool_Collateral_Before, A_collateral.add(B_collateral))
        assert.equal(activePool_RawCollateral_Before, A_collateral.add(B_collateral))
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_Before, A_totalDebt.add(B_totalDebt))
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        //await priceFeed.setPrice('100000000000000000000');
    
        // move market enough to cause par to liquidate bob's trove
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        /* close Bob's Trove. Should liquidate his ether and LUSD, 
        leaving Alice’s ether and LUSD debt in the ActivePool. */
        await liquidations.liquidate(bob, { from: owner });
    
        // check ActivePool collateral and LUSD debt 
        const activePool_Collateral_After = await activePool.getCollateral()
        const activePool_RawCollateral_After = await collateralToken.balanceOf(activePool.address)
        const activePool_LUSDDebt_After = await activePool.getLUSDDebt()
    
        // TODO fix off by one
        //assert.equal(activePool_Collateral_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_Collateral_After, A_collateral), 1)
        //assert.equal(activePool_RawEther_After, A_collateral)
        assert.isAtMost(th.getDifference(activePool_RawCollateral_After, A_collateral), 1)
        th.assertIsApproximatelyEqual(activePool_LUSDDebt_After, A_totalDebt)
      })
    
      it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check DefaultPool Collateral and LUSD debt before
        const defaultPool_Collateral_Before = (await defaultPool.getCollateral())
        const defaultPool_RawCollateral_Before = (await collateralToken.balanceOf(defaultPool.address)).toString()
        const defaultPool_LUSDDebt_Before = (await defaultPool.getLUSDDebt()).toString()
    
        assert.equal(defaultPool_Collateral_Before, '0')
        assert.equal(defaultPool_RawCollateral_Before, '0')
        assert.equal(defaultPool_LUSDDebt_Before, '0')
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // close Bob's Trove
        tx = await liquidations.liquidate(bob, { from: owner });
    
        /*
        liq_event = tx.logs.find(e => e.event === 'TroveLiqInfo');
        console.log("entireColl", liq_event.args.entireColl.toString())
        console.log("collToLiquidate", liq_event.args.collToLiquidate.toString())
        console.log("B_collateral", B_collateral.toString())
        */
    
        // check after
        const defaultPool_Collateral_After = await defaultPool.getCollateral()
        const defaultPool_RawCollateral_After = await collateralToken.balanceOf(defaultPool.address)
        const defaultPool_LUSDDebt_After = await defaultPool.getLUSDDebt()
    
        const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)
    
        // TODO: should these be exactly equal?
        //assert.isTrue(defaultPool_Collateral_After.eq(defaultPool_Collateral))
        assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
        //assert.isTrue(defaultPool_RawCollateral_After.eq(defaultPool_Collateral))
        assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
        //assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
    
        th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
      })
      it("liquidate(): increases DefaultPool Collateral and LUSD debt by correct amounts, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check DefaultPool Collateral and LUSD debt before
        const defaultPool_Collateral_Before = (await defaultPool.getCollateral())
        const defaultPool_RawCollateral_Before = (await collateralToken.balanceOf(defaultPool.address)).toString()
        const defaultPool_LUSDDebt_Before = (await defaultPool.getLUSDDebt()).toString()
    
        assert.equal(defaultPool_Collateral_Before, '0')
        assert.equal(defaultPool_RawCollateral_Before, '0')
        assert.equal(defaultPool_LUSDDebt_Before, '0')
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // close Bob's Trove
        await liquidations.liquidate(bob, { from: owner });
    
        // check after
        const defaultPool_Collateral_After = (await defaultPool.getCollateral()).toString()
        const defaultPool_RawCollateral_After = (await collateralToken.balanceOf(defaultPool.address)).toString()
        const defaultPool_LUSDDebt_After = (await defaultPool.getLUSDDebt()).toString()
    
        const defaultPool_Collateral = th.applyLiquidationFee(B_collateral)
    
        // console.log("defaultPool_Collateral_After", defaultPool_Collateral_After.toString())
        // console.log("defaultPool_Collateral", defaultPool_Collateral.toString())
    
        // TODO: should these be exactly equal?
        //assert.equal(defaultPool_Collateral_After, defaultPool_Collateral)
        assert.isAtMost(th.getDifference(defaultPool_Collateral_After, defaultPool_Collateral), 1)
        //assert.equal(defaultPool_RawCollateral_After, defaultPool_Collateral)
        assert.isAtMost(th.getDifference(defaultPool_RawCollateral_After, defaultPool_Collateral), 1)
        th.assertIsApproximatelyEqual(defaultPool_LUSDDebt_After, B_totalDebt)
      })
    
      it("liquidate(): removes the Trove's stake from the total stakes", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check totalStakes before
        const totalStakes_Before = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_Before, A_collateral.add(B_collateral))
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // Close Bob's Trove
        await liquidations.liquidate(bob, { from: owner });
    
        // check totalStakes after
        const totalStakes_After = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_After, A_collateral)
      })
      it("liquidate(): removes the Trove's stake from the total stakes, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check totalStakes before
        const totalStakes_Before = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_Before, A_collateral.add(B_collateral))
    
        // price drops to 1Collateral:100LUSD, reducing Bob's ICR below MCR
        //await priceFeed.setPrice('100000000000000000000');
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))

        // Close Bob's Trove
        await liquidations.liquidate(bob, { from: owner });
    
        // check totalStakes after
        const totalStakes_After = (await rewards.totalStakes()).toString()
        assert.equal(totalStakes_After, A_collateral)
      })
    
      it("liquidate(): Removes the correct trove from the TroveOwners array, and moves the last array element to the new empty slot", async () => {
        // --- SETUP --- 
        await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: whale } })
    
        // Alice, Bob, Carol, Dennis, Erin open troves with consecutively decreasing collateral ratio
        await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(216, 16)), extraParams: { from: bob } })
        await openTrove({ ICR: toBN(dec(214, 16)), extraParams: { from: carol } })
        await openTrove({ ICR: toBN(dec(212, 16)), extraParams: { from: dennis } })
        await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: erin } })
    
        // At this stage, TroveOwners array should be: [W, A, B, C, D, E] 
    
        // Drop price
        await priceFeed.setPrice(dec(100, 18))
    
        const arrayLength_Before = await troveManager.getTroveOwnersCount()
        assert.equal(arrayLength_Before, 6)
        assert.isFalse(await th.checkRecoveryMode(contracts))
         // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))   
        // Liquidate carol
        await liquidations.liquidate(carol)
    
        // Check Carol no longer has an active trove
        assert.isFalse(await sortedTroves.contains(carol))
    
        // Check length of array has decreased by 1
        const arrayLength_After = await troveManager.getTroveOwnersCount()
        assert.equal(arrayLength_After, 5)
    
        /* After Carol is removed from array, the last element (Erin's address) should have been moved to fill 
        the empty slot left by Carol, and the array length decreased by one.  The final TroveOwners array should be:
      
        [W, A, B, E, D] 
    
        Check all remaining troves in the array are in the correct order */
        const trove_0 = await troveManager.TroveOwners(0)
        const trove_1 = await troveManager.TroveOwners(1)
        const trove_2 = await troveManager.TroveOwners(2)
        const trove_3 = await troveManager.TroveOwners(3)
        const trove_4 = await troveManager.TroveOwners(4)
    
        assert.equal(trove_0, whale)
        assert.equal(trove_1, alice)
        assert.equal(trove_2, bob)
        assert.equal(trove_3, erin)
        assert.equal(trove_4, dennis)
    
        // Check correct indices recorded on the active trove structs
        const whale_arrayIndex = (await troveManager.Troves(whale))[4]
        const alice_arrayIndex = (await troveManager.Troves(alice))[4]
        const bob_arrayIndex = (await troveManager.Troves(bob))[4]
        const dennis_arrayIndex = (await troveManager.Troves(dennis))[4]
        const erin_arrayIndex = (await troveManager.Troves(erin))[4]
    
        // [W, A, B, E, D] 
        assert.equal(whale_arrayIndex, 0)
        assert.equal(alice_arrayIndex, 1)
        assert.equal(bob_arrayIndex, 2)
        assert.equal(erin_arrayIndex, 3)
        assert.equal(dennis_arrayIndex, 4)
      })
    
      it("liquidate(): updates the snapshots of total stakes and total collateral", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check snapshots before 
        const totalStakesSnapshot_Before = (await rewards.totalStakesSnapshot()).toString()
        const totalCollateralSnapshot_Before = (await rewards.totalCollateralSnapshot()).toString()
        assert.equal(totalStakesSnapshot_Before, '0')
        assert.equal(totalCollateralSnapshot_Before, '0')
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
        await liquidations.liquidate(bob, { from: owner });
    
        /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
        10 ether, Alice's stake.
         
        Total collateral should be equal to Alice's collateral plus her pending collateral reward (Bob's collaterale*0.995 ether), earned
        from the liquidation of Bob's Trove */
        const totalStakesSnapshot_After = await rewards.totalStakesSnapshot()
        const totalCollateralSnapshot_After = await rewards.totalCollateralSnapshot()
    
        assert.isTrue(totalStakesSnapshot_After.eq(A_collateral))
        //assert.isTrue(totalCollateralSnapshot_After.eq(A_collateral.add(th.applyLiquidationFee(B_collateral))))
        // TODO fix off by one
        assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
    
      })
      it("liquidate(): updates the snapshots of total stakes and total collateral, rising par", async () => {
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(10, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: bob } })
    
        // --- TEST ---
    
        // check snapshots before 
        const totalStakesSnapshot_Before = (await rewards.totalStakesSnapshot()).toString()
        const totalCollateralSnapshot_Before = (await rewards.totalCollateralSnapshot()).toString()
        assert.equal(totalStakesSnapshot_Before, '0')
        assert.equal(totalCollateralSnapshot_Before, '0')
    
        // price drops to 1CollateralToken:100LUSD, reducing Bob's ICR below MCR
        //await priceFeed.setPrice('100000000000000000000');
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(8).mul(ONE_CENT)));
        await relayer.updatePar();
        th.fastForwardTime(12 * 3600, web3.currentProvider)
        await relayer.updatePar();
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // close Bob's Trove.  His ether*0.995 and LUSD should be added to the DefaultPool.
        await liquidations.liquidate(bob, { from: owner });
    
        /* check snapshots after. Total stakes should be equal to the  remaining stake then the system: 
        10 ether, Alice's stake.
         
        Total collateral should be equal to Alice's collateral plus her pending collateral reward (Bob's collateral*0.995 ether), earned
        from the liquidation of Bob's Trove */
        const totalStakesSnapshot_After = (await rewards.totalStakesSnapshot()).toString()
        const totalCollateralSnapshot_After = (await rewards.totalCollateralSnapshot()).toString()
    
        assert.equal(totalStakesSnapshot_After, A_collateral)
        // TODO fix off by one
        //assert.equal(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral)))
        assert.isAtMost(th.getDifference(totalCollateralSnapshot_After, A_collateral.add(th.applyLiquidationFee(B_collateral))), 1)
      })
    
      it("liquidate(): updates the L_Coll and L_LUSDDebt reward-per-unit-staked totals", async () => {
        await rateControl.setCoBias(0)
        // --- SETUP ---
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
        const { collateral: B_collateral, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
        const { collateral: C_collateral, totalDebt: C_totalDebt } = await openTrove({ ICR: toBN(dec(111, 16)), extraParams: { from: carol } })

        // --- TEST ---
    
        // price drops to 1CollateralToken:100LUSD, reducing Carols's ICR below MCR
        await priceFeed.setPrice('100000000000000000000');
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price keeps droping to drop collateral and debt
        const tcrPrice =await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        const L_Coll_BeforeCarolLiquidated = await rewards.L_Coll()
        const L_LUSDDebt_BeforeCarolLiquidated = await rewards.L_LUSDDebt()
    
        // close Carol's Trove.  
        assert.isTrue(await sortedTroves.contains(carol))
        await liquidations.liquidate(carol, { from: owner });
        assert.isFalse(await sortedTroves.contains(carol))
    
        // Carol's collateral*0.995 and LUSD should be added to the DefaultPool.
        const L_Coll_AfterCarolLiquidated = await rewards.L_Coll()
        const L_LUSDDebt_AfterCarolLiquidated = await rewards.L_LUSDDebt()
    
        // Debug values for understanding the issue
        const totalStakes_afterCarol = await rewards.totalStakes()
        const A_stake_afterCarol = await troveManager.getTroveStake(alice)
        const B_stake_afterCarol = await troveManager.getTroveStake(bob)
        const expectedLiquidationFee = C_collateral.div(toBN(200))
        const liquidatedCollAfterFee = C_collateral.sub(expectedLiquidationFee) //th.applyLiquidationFee(C_collateral)
    
        const L_Coll_expected_1 = liquidatedCollAfterFee.mul(mv._1e18BN).div(totalStakes_afterCarol)
        const L_LUSDDebt_expected_1 = C_totalDebt.mul(mv._1e18BN).div(totalStakes_afterCarol)
    
        assert.isAtMost(th.getDifference(L_Coll_AfterCarolLiquidated, L_Coll_expected_1), 100)
        assert.isAtMost(th.getDifference(L_LUSDDebt_AfterCarolLiquidated, L_LUSDDebt_expected_1), 100)
    
        b_coll = (await troveManager.getEntireDebtAndColl(bob))[1]
        b_coll_pending = (await troveManager.getEntireDebtAndColl(bob))[3]
        b_exp = B_collateral.mul(L_Coll_expected_1).div(mv._1e18BN)
        /*
        console.log("b_coll", b_coll.toString())
        console.log("b_exp", b_exp.toString())
        console.log("b_coll_pending", b_coll_pending.toString())
        */
    
        // Bob now withdraws LUSD, bringing his ICR to 1.11
        const price = await priceFeed.getPrice();
        const res = await troveManager.getEntireDebtAndColl(bob);
        const collEff = res[1].add(res[3]);    
        const debtActual = await troveManager.getTroveActualDebt(bob);

        const targetICR = toBN(dec(111,16)); // 1.11e18
        const parTarget = await calculateParTarget(price, collEff, debtActual, targetICR);

        await driveICRToTargetWithPar(bob, parTarget);

        // price drops to 1CollateralToken:50LUSD, reducing Bob's ICR below MCR
        // await priceFeed.setPrice(dec(50, 18));
        // const price = await priceFeed.getPrice()
    
        assert.isTrue(await sortedTroves.contains(bob))
        tx = await liquidations.liquidate(bob, { from: owner });
        assert.isFalse(await sortedTroves.contains(bob))
    
        /* Alice now has all the active stake. totalStakes in the system is now 10 collateral token.
      
       Bob's pending collateral reward and debt reward are applied to his Trove
       before his liquidation.
       His total collateral*0.995 and debt are then added to the DefaultPool. 
       
       The system rewards-per-unit-staked should now be:
       
       L_Coll = (0.995 / 20) + (10.4975*0.995  / 10) = 1.09425125 CollateralToken
       L_LUSDDebt = (180 / 20) + (890 / 10) = 98 LUSD */
        const L_Coll_AfterBobLiquidated = await rewards.L_Coll()
        const L_LUSDDebt_AfterBobLiquidated = await rewards.L_LUSDDebt()
    
        const B_increasedTotalDebt = toBN('0'); // no borrow; par/price only

        const L_Coll_expected_2 = L_Coll_expected_1.add(th.applyLiquidationFee(B_collateral.add(B_collateral.mul(L_Coll_expected_1).div(mv._1e18BN))).mul(mv._1e18BN).div(A_collateral))
        const L_LUSDDebt_expected_2 = L_LUSDDebt_expected_1.add(B_totalDebt.add(B_increasedTotalDebt).add(B_collateral.mul(L_LUSDDebt_expected_1).div(mv._1e18BN)).mul(mv._1e18BN).div(A_collateral))
    
        assert.isAtMost(th.getDifference(L_Coll_AfterBobLiquidated, L_Coll_expected_2), 100)
        assert.isAtMost(th.getDifference(L_LUSDDebt_AfterBobLiquidated, L_LUSDDebt_expected_2), 100)
      })
    
    
      it("liquidate(): Liquidates undercollateralized trove if there are two troves in the system", async () => {
        await openTrove({ ICR: toBN(dec(200, 18)), extraParams: { from: bob, value: dec(100, 'ether') } })
    
        // Alice creates a single trove with 0.7 CT and a debt of 70 LUSD, and provides 10 LUSD to SP
        const { collateral: A_collateral, totalDebt: A_totalDebt } = await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } })
    
        // Alice proves 10 LUSD to SP
        await stabilityPool.provideToSP(dec(10, 18), ZERO_ADDRESS, { from: alice })
    
        // Set CollateralToken:USD price to 105
        await priceFeed.setPrice('105000000000000000000')
        const price = await priceFeed.getPrice()
        assert.isFalse(await th.checkRecoveryMode(contracts))
    
        const alice_ICR = (await troveManager.getCurrentICR(alice, price)).toString()
        assert.equal(alice_ICR, '1050000000000000000')
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lte(mv._MCR))
    
        const activeTrovesCount_Before = await troveManager.getTroveOwnersCount()
    
        assert.equal(activeTrovesCount_Before, 2)
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // console.log("before liq")
        // console.log("bob actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
        // console.log("bob entire debt", (await contracts.troveManager.getEntireDebtAndColl(bob))[0].toString())
        // console.log("alice actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
        // console.log("debt", (await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())).toString())
        // console.log("supply", (await contracts.lusdToken.totalSupply()).toString())
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // Liquidate
        tx = await liquidations.liquidate(alice, { from: owner })
    
        // Check Alice's trove is removed, and bob remains
        const activeTrovesCount_After = await troveManager.getTroveOwnersCount()
        assert.equal(activeTrovesCount_After, 1)
    
        const alice_isInSortedList = await sortedTroves.contains(alice)
        assert.isFalse(alice_isInSortedList)
    
        const bob_isInSortedList = await sortedTroves.contains(bob)
        assert.isTrue(bob_isInSortedList)
    
        // console.log("after liq")
        // console.log("bob actual debt", (await contracts.troveManager.getTroveActualDebt(bob)).toString())
        // console.log("bob entire debt", (await contracts.troveManager.getEntireDebtAndColl(bob))[0].toString())
        // console.log("default pool coll", (await contracts.defaultPool.getCollateral()).toString())
        // console.log("alice actual debt", (await contracts.troveManager.getTroveActualDebt(alice)).toString())
        // console.log("debt", (await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())).toString())
        // console.log("supply", (await contracts.lusdToken.totalSupply()).toString())
      })
    
      it("liquidate(): reverts if trove is non-existent", async () => {
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(21, 17)), extraParams: { from: bob } })
    
        assert.equal(await troveManager.getTroveStatus(carol), 0) // check trove non-existent
        // price drops to below ccr collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        assert.isFalse(await sortedTroves.contains(carol))
    
        try {
          const txCarol = await liquidations.liquidate(carol)
    
          assert.isFalse(txCarol.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          assert.include(err.message, "Trove does not exist or is closed")
        }
      })
    
      it("liquidate(): reverts if trove has been closed", async () => {
        await openTrove({ ICR: toBN(dec(8, 18)), extraParams: { from: alice } })
        await openTrove({ ICR: toBN(dec(4, 18)), extraParams: { from: bob } })
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: carol } })
    
        assert.isTrue(await sortedTroves.contains(carol))
        
        // price drops, Carol ICR falls below MCR
        await priceFeed.setPrice(dec(100, 18))
         // price keeps droping to drop collateral and debt
         await tcrShutdown()

         assert.isTrue(await th.checkRecoveryMode(contracts))   
        // Carol liquidated, and her trove is closed
        const txCarol_L1 = await liquidations.liquidate(carol)
        assert.isTrue(txCarol_L1.receipt.status)
    
        assert.isFalse(await sortedTroves.contains(carol))
    
        assert.equal(await troveManager.getTroveStatus(carol), 3)  // check trove closed by liquidation
    
        try {
          const txCarol_L2 = await liquidations.liquidate(carol)
    
          assert.isFalse(txCarol_L2.receipt.status)
        } catch (err) {
          assert.include(err.message, "revert")
          assert.include(err.message, "Trove does not exist or is closed")
        }
      })
    
      it("liquidate(): does nothing if trove has >= 110% ICR", async () => {
        await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: whale } })
        await openTrove({ ICR: toBN(dec(3, 18)), extraParams: { from: bob } })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        const price = await priceFeed.getPrice()
        
        // Check Bob's ICR > 110%
        const bob_ICR = await troveManager.getCurrentICR(bob, price)

        assert.isTrue(bob_ICR.gte(mv._MCR))
        assert.isFalse(await th.checkRecoveryMode(contracts))
        // price drops to tcr < scr and system is shut down
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // drive par to make bob's ICR < MCR
        const { par: parAfter, priceUsed: priceTargetAfter } = await driveICRToTargetWithPar(bob, mv._MCR)

        // check bob's ICR < MCR
        const bob_ICR_After  = await troveManager.getCurrentICR(bob, priceTargetAfter)
        assert.isTrue(bob_ICR_After.gte(mv._MCR))
        // Attempt to liquidate bob
        await assertRevert(liquidations.liquidate(bob), "Liquidations: nothing to liquidate")
    
        // Check bob active, check whale active
        assert.isTrue((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()

        assert.equal(TCR_After, mv._MCR)
        assert.equal(listSize_Before, listSize_After)
      })
    
      it("liquidate(): surplus collateral if liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
    
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).gt((await liquidations.LIQUIDATION_PENALTY())))

        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
        const offsetActualBaseDebt = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "actualBaseDebt");
        const offsetBaseDebt = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "baseDebt");
        const offsetBaseColl = th.getRawEventArgByName(tx, liquidationsInterface, liquidations.address, "Offset", "baseColl");
    
        // console.log("offsetActualBaseDebt", offsetActualBaseDebt.toString())
        // console.log("offsetBaseDebt", offsetBaseDebt.toString())
        // console.log("offsetBaseColl", offsetBaseColl.toString())
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        // console.log("bobCollateral", bobCollateral.toString())
        // console.log("liquidatedColl", liquidatedColl.toString())
        // console.log("ethGain", ethGain.toString())
        // assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 96000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      
      it("liquidate(): surplus collateral if liquidated by par above penalty", async () => {
        // disable rates to ensure ICR change is from par only
        await contracts.rateControl.setCoBias(0)
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        // this will raise par, increasing ICR
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(1).mul(ONE_CENT)));
        await relayer.updatePar()
    
        price = await priceFeed.getPrice()
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      it("liquidate(): surplus collateral if liquidated by drip above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        price = await priceFeed.getPrice()
        // exactly eq to MCR, so drip in liquidate will make trove liquidatable
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).eq((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
      })
      it("liquidate(): surplus collateral if liquidated above penalty, redistribution", async () => {
        // set liq penalty to less than MCR
        await liquidations.setLiqPenaltyRedist(toBN(dec(106, 16)));
        await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
        price = dec(100, 18)
        await priceFeed.setPrice(price)
    
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
       
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
        // bob has surplus collateral
        // bobSurplus = await contracts.collSurplusPool.getCollateral(bob)
    
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      it("liquidate(): surplus collateral if liquidated by par above penalty, redistribution", async () => {
        // disable rates to ensure ICR change is from par only
        await contracts.rateControl.setCoBias(0)
        // set liq penalty to less than MCR
        await liquidations.setLiqPenaltyRedist(toBN(dec(106, 16)));
    
    
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(100, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        // Need to provideToSp since interest cannot accrue when SP is empty. interest is needed to make bob < MCR
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
        // open another trove so drip() can now reduce bob's ICR
        await openTrove({ ICR: toBN(dec(200, 16)), extraParams: { from: carol } })
        // withdraw so redistribution will happen w/ next liquidation
        await stabilityPool.withdrawFromSP(spDeposit.sub(toBN(dec(1,18))), { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        // this will raise par, increasing ICR
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(1).mul(ONE_CENT)));
        await relayer.updatePar()
    
        price = await priceFeed.getPrice()
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        tx = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
    
        // check bob eth difference, considering eth used in tx
        txCost = th.ethUsed(tx)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
      })
      it("liquidate(): no surplus collateral if liquidated below penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(209, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
    
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated below penalty, redistribution", async () => {
        await liquidations.setLiqPenaltyRedist(toBN(dec(109, 16)));
        await openTrove({ ICR: toBN(dec(100, 18)), extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(209, 16)), extraParams: { from: bob } })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
        // price keeps droping to drop collateral and debt
        await tcrShutdown()

        assert.isTrue(await th.checkRecoveryMode(contracts))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await liquidations.LIQUIDATION_PENALTY_REDIST())))
    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has no surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob can't claim surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated by par below penalty", async () => {
        // disable rates to ensure ICR change is from par only
        await contracts.rateControl.setCoBias(0)
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        // this will raise par, increasing ICR
        await marketOracle.setPrice(ONE_DOLLAR.sub(toBN(5).mul(ONE_CENT)));
        await relayer.updatePar()
        
        // par rate of change is bounded so we need a lot of time to make a par change large
        // enough to cause ICR < LIQ_PENALTY
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_MONTH, web3.currentProvider)
    
        await relayer.updatePar()
    
        price = await priceFeed.getPrice()
    
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has no surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated by rate below penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(110, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        // we need a lot of time to make dripped interest to cause ICR < LIQ_PENALTY
        await th.fastForwardTime(100*timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
        await relayer.updateRate()
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        price = await priceFeed.getPrice()
    
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).eq((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 107000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidate(): no surplus collateral if liquidated at penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(210, 16)), extraParams: { from: bob } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = (await sortedTroves.getSize()).toString()
    
        await priceFeed.setPrice(dec(100, 18))
    
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, dec(100, 18))).eq((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate bob
        tx = await liquidations.liquidate(bob)
    
        const [liquidatedDebt, liquidatedColl, collGasComp, lusdGasComp] = th.getEmittedLiquidationValues(tx)
    
        gasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(collGasComp.eq(gasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(liquidatedColl, ethGain), 100000)
    
        // Check bob in-active, check whale active
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = (await sortedTroves.getSize()).toString()
    
        // bob has been removed from list
        assert.isTrue(listSize_Before > listSize_After)
    
        // bob has no surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.eq(toBN('0')))
    
        assert.isTrue(liquidatedColl.add(collGasComp).add(bobSurplus).eq(bobCollateral))
    
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
    
        // bob claims surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })

      it("liquidate(): surplus collateral if A,B,C liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
        const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })
    
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
        // Prefer targeting above the redist penalty to guarantee surplus even with redist
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceOpen = await priceFeed.getPrice();
        const parOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceOpen / pLiq) * (parLiq / parOpen)
        const parLiq = parOpen;
        const icrOpenTarget = targetICRliq.mul(priceOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parOpen);
        await tuneDebtToICROpen(alice, icrOpenTarget, priceOpen, parOpen)
        await tuneDebtToICROpen(bob, icrOpenTarget, priceOpen, parOpen)
        await tuneDebtToICROpen(carol, icrOpenTarget, priceOpen, parOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(alice, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()
      
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        // calc liquidation tcr between LIQUIDATION_PENALTY and MCR
   
        assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate alice
        tx_alice = await liquidations.liquidate(alice)
        const [aliceLiquidatedDebt, aliceLiquidatedColl, aliceCollGasComp, aliceLusdGasComp] = th.getEmittedLiquidationValues(tx_alice)
        aliceGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(aliceCollGasComp.eq(aliceGasComp))
    
        // liquidate bob
        tx_bob = await liquidations.liquidate(bob)
        const [bobLiquidatedDebt, bobLiquidatedColl, bobCollGasComp, bobLusdGasComp] = th.getEmittedLiquidationValues(tx_bob)
        bobGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(bobCollGasComp.eq(bobGasComp))
    
        // liquidate carol
        tx_carol = await liquidations.liquidate(carol)
        const [carolLiquidatedDebt, carolLiquidatedColl, carolCollGasComp, carolLusdGasComp] = th.getEmittedLiquidationValues(tx_carol)
        carolGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(carolCollGasComp.eq(carolGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl), ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        console.log('aliceSurplus', aliceSurplus.toString());
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        // check total surplus
        totalSurplus = await collSurplusPool.getCollateral()
        assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))
    
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(bobAmount).eq(bobSurplus))
        // carol claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
        const carolAmount = th.getRawEventArgByName(tx_carol_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(carolAmount).eq(carolSurplus))
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("liquidateTroves(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
        const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })
    
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
        // Prefer targeting above the redist penalty to guarantee surplus even with redist
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceOpen = await priceFeed.getPrice();
        const parOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceOpen / pLiq) * (parLiq / parOpen)
        const parLiq = parOpen;
        const icrOpenTarget = targetICRliq.mul(priceOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parOpen);
        await tuneDebtToICROpen(alice, icrOpenTarget, priceOpen, parOpen)
        await tuneDebtToICROpen(bob, icrOpenTarget, priceOpen, parOpen)
        await tuneDebtToICROpen(carol, icrOpenTarget, priceOpen, parOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(alice, targetICRliq)
        await driveICRToTargetWithPar(bob, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // liquidate all
        tx_liq = await liquidations.liquidateTroves(3)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        // check total surplus
        totalSurplus = await collSurplusPool.getCollateral()
        assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))
    
        aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        aliceCollGasComp = totalGasComp.div(toBN('3'))
        bobCollGasComp = totalGasComp.div(toBN('3'))
        carolCollGasComp = totalGasComp.div(toBN('3'))
    
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // bob claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("batchLiquidate(): A,B,C same size troves. surplus collateral if A,B,C liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
        const {collateral: aliceCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: bob } })
        const {collateral: carolCollateral} = await openTrove({ ICR: toBN(dec(215, 16)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
          
        // Choose target band at liquidation
        const penalty = await liquidations.LIQUIDATION_PENALTY();
   
        const mcr = await troveManager.MCR();
        // Prefer targeting above the redist penalty to guarantee surplus even with redist
        const targetICRliq = penalty.add(toBN(dec(1,16))).add(mcr).div(toBN(2)); // midpoint in (penaltyRedist, MCR)

        // Capture current price/par (open-time)
        const priceOpen = await priceFeed.getPrice();
        const parOpen = await relayer.par();

        // Compute SCR price from current totals, then choose liquidation price just below SCR
        const scrPrice = await calcSCRPrice();

        // Compute the ICR needed at open so that ICR_liq hits target at pLiq
        // icr_open = targetICRliq * (priceOpen / pLiq) * (parLiq / parOpen)
        const parLiq = parOpen;
        const icrOpenTarget = targetICRliq.mul(priceOpen).mul(parLiq).div(scrPrice.sub(toBN('1'))).div(parOpen);
        await tuneDebtToICROpen(alice, icrOpenTarget, priceOpen, parOpen)
        await tuneDebtToICROpen(bob, icrOpenTarget, priceOpen, parOpen)
        await tuneDebtToICROpen(carol, icrOpenTarget, priceOpen, parOpen)

        await tcrShutdown()
        // price drops to put tcr below scr
        await driveICRToTargetWithPar(alice, targetICRliq)
        await driveICRToTargetWithPar(bob, targetICRliq)
        // await priceFeed.setPrice(dec(100, 18))
        const priceNow = await priceFeed.getPrice()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, priceNow)).gt((await liquidations.LIQUIDATION_PENALTY())))
    
        // liquidate all
        //tx_liq = await liquidations.liquidateTroves(3)
        tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        // check total surplus
        totalSurplus = await collSurplusPool.getCollateral()
        assert.isTrue(totalSurplus.eq(aliceSurplus.add(bobSurplus).add(carolSurplus)))
    
        aliceLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        bobLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        carolLiquidatedColl = totalLiquidatedColl.div(toBN('3'))
        aliceCollGasComp = totalGasComp.div(toBN('3'))
        bobCollGasComp = totalGasComp.div(toBN('3'))
        carolCollGasComp = totalGasComp.div(toBN('3'))
    
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // carol claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("liquidateTroves(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(219, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
    
    
        //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
        entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
              .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))
    
        price = dec(100, 18)
        await priceFeed.setPrice(price)
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
    
        // ensure trove owners will have surplus collateral after liquidation
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate all
        tx_liq = await liquidations.liquidateTroves(3)
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        entireDebtDrip = entireDebt.add(totalInterest)
        
        aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
        bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
        carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))
    
        // console.log("totalLiquidatedDebt", totalLiquidatedDebt.toString())
    
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 102000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl) // totalLiquidatedDebt.mul(par).mul((await troveManager.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        //expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        //console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        // console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        // console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
    
        assert.isTrue(totalLiquidatedColl.eq(expTotalLiquidatedColl))
        // // verify total liq coll
        // assert.isAtMost(th.getDifference(expTotalLiquidatedColl, totalLiquidatedColl), 2)
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        // verify collateral invariant
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // bob claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("batchLiquidate(): A,B,C different size troves, different ICRs. A,B,C have surplus collateral liquidated above penalty", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(219, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
    
    
        //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
        entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
              .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))
    
        price = dec(100, 18)
        await priceFeed.setPrice(price)
    
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
    
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate all
        tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        
        aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
        bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
        carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))
    
        //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100030)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol has surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.gt(toBN('0')))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        /*
        console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
        */
    
        // verify total liq coll
        assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        // verify collateral invariant
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        // bob claims surplus collateral
        tx_carol_claim = await borrowerOperations.claimCollateral({ from: carol, gasprice:0})
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        // check carol eth difference, considering eth used in tx
        carolTxCost = th.ethUsed(tx_carol_claim)
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        assert.isTrue(carolBalanceDiff.eq(carolSurplus))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
      })
      it("liquidateTroves(): A,B,C different size troves, different ICRs. Only A,B have surplus collateral", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(210, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
    
    
        //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
        entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
              .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))
    
        price = dec(100, 18)
        await priceFeed.setPrice(price)
    
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
    
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
        // check for eq here since drip() in liquidate will pull carol under the penalty 
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).eq((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate all
        tx_liq = await liquidations.liquidateTroves(3)
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        
        aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
        bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
        carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))
    
        //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol does not have surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        assert.isTrue(carolSurplus.eq(toBN('0')))
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        //carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolCollateral.sub(carolCollGasComp)
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        /*
        console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
        */
    
        // verify total liq coll
        assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))
    
        // verify collateral invariant
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(bobAmount).eq(bobSurplus))
        // carol can't claim surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        // carol should gain no collateral
        assert.isTrue(carolBalanceDiff.eq(toBN('0')))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
      it("batchLiquidate(): A,B,C different size troves, different ICRs. Only A,B have surplus collateral", async () => {
        const spDeposit = toBN(dec(100, 21))
        await openTrove({ ICR: toBN(dec(3, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        const {collateral: aliceCollateral, totalDebt: aliceDebt, ICR: alice_ICR} = await openTrove({ ICR: toBN(dec(218, 16)), extraParams: { from: alice } })
        const {collateral: bobCollateral, totalDebt: bobDebt, ICR: bob_ICR} = await openTrove({ ICR: toBN(dec(216, 16)), extraLUSDAmount: toBN(dec(5,21)), extraParams: { from: bob } })
        const {collateral: carolCollateral, totalDebt: carolDebt, ICR: carol_ICR} = await openTrove({ ICR: toBN(dec(210, 16)), extraLUSDAmount: toBN(dec(20,21)), extraParams: { from: carol } })
    
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        const TCR_Before = (await th.getTCR(contracts)).toString()
        const listSize_Before = await sortedTroves.getSize()
    
    
        //console.log("entire debt", (await troveManager.getEntireSystemActualDebt()).toString())
        entireDebt = (await troveManager.getTroveActualDebt(alice)).add((await troveManager.getTroveActualDebt(bob)))
              .add((await troveManager.getTroveActualDebt(carol))).add((await troveManager.getTroveActualDebt(whale)))
    
        price = dec(100, 18)
        await priceFeed.setPrice(price)
    
    
        aliceICR = await troveManager.getCurrentICR(alice, price)
        bobICR = await troveManager.getCurrentICR(bob, price)
        carolICR = await troveManager.getCurrentICR(carol, price)
        // console.log("aliceICR", aliceICR.toString())
        // console.log("bobICR", bobICR.toString())
        // console.log("carolICR", carolICR.toString())
    
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(alice, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).lt((await troveManager.MCR())))
        assert.isTrue((await troveManager.getCurrentICR(bob, price)).gt((await liquidations.LIQUIDATION_PENALTY())))
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).lt((await troveManager.MCR())))
        // check for eq here since drip() in liquidate will pull carol under the penalty 
        assert.isTrue((await troveManager.getCurrentICR(carol, price)).eq((await liquidations.LIQUIDATION_PENALTY())))
            // price keeps droping to drop collateral and debt
            await tcrShutdown()

            assert.isTrue(await th.checkRecoveryMode(contracts))
        // liquidate all
        tx_liq = await liquidations.batchLiquidate([alice, bob, carol])
        //tx_liq = await liquidations.liquidate(alice)
        const [totalLiquidatedDebt, totalLiquidatedColl, totalCollGasComp, totalLusdGasComp] = th.getEmittedLiquidationValues(tx_liq)
    
        //const [stakeDrip, spDrip] = th.getEmittedDripValues(contracts,tx_liq)
        spDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_spInterest"))
        remDrip = toBN(th.getRawEventArgByName(tx_liq, feeRouterInterface, feeRouter.address, "Drip", "_remaining"))
    
        totalInterest = remDrip.add(spDrip)
        
        aliceDebtLiq = aliceDebt.add((totalInterest.mul(aliceDebt).div(entireDebt)))
        bobDebtLiq = bobDebt.add((totalInterest.mul(bobDebt).div(entireDebt)))
        carolDebtLiq = carolDebt.add((totalInterest.mul(carolDebt).div(entireDebt)))
    
        //assert.isTrue(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq).eq(totalLiquidatedDebt))
        assert.isAtMost(th.getDifference(aliceDebtLiq.add(bobDebtLiq).add(carolDebtLiq), totalLiquidatedDebt), 3)
    
        totalGasComp = (aliceCollateral.add(bobCollateral).add(carolCollateral)).div(await troveManager.PERCENT_DIVISOR())
        assert.isTrue(totalCollGasComp.eq(totalGasComp))
    
        ethGain = await stabilityPool.getDepositorCollateralGain(whale)
        assert.isAtMost(th.getDifference(totalLiquidatedColl, ethGain), 100000)
    
        // Check alice, bob, carol in-active, check whale active
        assert.isFalse((await sortedTroves.contains(alice)))
        assert.isFalse((await sortedTroves.contains(bob)))
        assert.isFalse((await sortedTroves.contains(carol)))
        assert.isTrue((await sortedTroves.contains(whale)))
    
        const TCR_After = (await th.getTCR(contracts)).toString()
        const listSize_After = await sortedTroves.getSize()
    
        // alice, bob, carol have been removed from list
        assert.isTrue(listSize_Before == 4)
        assert.isTrue(listSize_After == 1)
    
        // alice has surplus collateral
        aliceSurplus = await th.getCollateralFromCollSurplusPool(contracts, alice)
        assert.isTrue(aliceSurplus.gt(toBN('0')))
    
        // bob has surplus collateral
        bobSurplus = await th.getCollateralFromCollSurplusPool(contracts, bob)
        assert.isTrue(bobSurplus.gt(toBN('0')))
    
        // carol does not have surplus collateral
        carolSurplus = await th.getCollateralFromCollSurplusPool(contracts, carol)
        console.log("carolSurplus " + carolSurplus)
        assert.isTrue(carolSurplus.eq(toBN('0')))
    
        // verift total gas comp
        aliceCollGasComp = aliceCollateral.div(await troveManager.PERCENT_DIVISOR())
        bobCollGasComp = bobCollateral.div(await troveManager.PERCENT_DIVISOR())
        carolCollGasComp = carolCollateral.div(await troveManager.PERCENT_DIVISOR())
    
        assert.isTrue(aliceCollGasComp.add(bobCollGasComp).add(carolCollGasComp).eq(totalGasComp))
    
        par = await relayer.par()
        aliceLiquidatedColl = aliceDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        bobLiquidatedColl = bobDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        //carolLiquidatedColl = carolDebtLiq.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        carolLiquidatedColl = carolCollateral.sub(carolCollGasComp)
    
        // calculating w/ totalLiquidatedDebt is one truncation, while internally, totalLiqColl is the sum of many truncations
        // so this can be off by a few wei
        //expTotalLiquidatedColl = totalLiquidatedDebt.mul(par).mul((await liquidations.LIQUIDATION_PENALTY())).div(toBN(price)).div(toBN(dec(1,18)))
        expTotalLiquidatedColl = aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl)
    
        /*
        console.log("exp total liq coll", aliceLiquidatedColl.add(bobLiquidatedColl).add(carolLiquidatedColl).toString())
        console.log("expTotalLiquidatedColl", expTotalLiquidatedColl.toString())
        console.log("totalLiquidatedColl", totalLiquidatedColl.toString())
        */
    
        // verify total liq coll
        assert.isTrue(expTotalLiquidatedColl.eq(totalLiquidatedColl))
    
        // verify collateral invariant
        assert.isTrue(aliceLiquidatedColl.add(aliceCollGasComp).add(aliceSurplus).eq(aliceCollateral))
        assert.isTrue(bobLiquidatedColl.add(bobCollGasComp).add(bobSurplus).eq(bobCollateral))
        assert.isTrue(carolLiquidatedColl.add(carolCollGasComp).add(carolSurplus).eq(carolCollateral))
    
        aliceBalanceBefore = toBN(await collateralToken.balanceOf(alice)) 
        bobBalanceBefore = toBN(await collateralToken.balanceOf(bob)) 
        carolBalanceBefore = toBN(await collateralToken.balanceOf(carol)) 
    
        // alice claims surplus collateral
        tx_alice_claim = await borrowerOperations.claimCollateral({ from: alice, gasprice:0})
        const aliceAmount = th.getRawEventArgByName(tx_alice_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(aliceAmount).eq(aliceSurplus))
        // bob claims surplus collateral
        tx_bob_claim = await borrowerOperations.claimCollateral({ from: bob, gasprice:0})
        const bobAmount = th.getRawEventArgByName(tx_bob_claim, collSurplusPoolInterface, collSurplusPool.address, "CollateralSent", "_amount");
        assert.isTrue(toBN(bobAmount).eq(bobSurplus))
        // carol can't claim surplus collateral
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
    
        // check alice eth difference, considering eth used in tx
        aliceTxCost = th.ethUsed(tx_alice_claim)
        aliceBalanceAfter = toBN(await collateralToken.balanceOf(alice)) 
        aliceBalanceDiff = aliceBalanceAfter.sub(aliceBalanceBefore)
    
        assert.isTrue(aliceBalanceDiff.eq(aliceSurplus))
    
        // alice 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: alice, gasprice:0}), "No collateral available to claim")
    
        // check bob eth difference, considering eth used in tx
        bobTxCost = th.ethUsed(tx_bob_claim)
        bobBalanceAfter = toBN(await collateralToken.balanceOf(bob)) 
        bobBalanceDiff = bobBalanceAfter.sub(bobBalanceBefore)
    
        assert.isTrue(bobBalanceDiff.eq(bobSurplus))
    
        // bob 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: bob, gasprice:0}), "No collateral available to claim")
    
        carolBalanceAfter = toBN(await collateralToken.balanceOf(carol)) 
        carolBalanceDiff = carolBalanceAfter.sub(carolBalanceBefore)
    
        // carol should gain no collateral
        assert.isTrue(carolBalanceDiff.eq(toBN('0')))
    
        // carol 2nd attempt to withdraw fails
        assertRevert(borrowerOperations.claimCollateral({ from: carol, gasprice:0}), "No collateral available to claim")
        assert.isTrue((await collSurplusPool.getCollateral()).eq(toBN('0')))
    
      })
    
      it("drip(): debt equals supply", async () => {
        // Whale provides LUSD to SP
        const spDeposit = toBN(dec(100, 24))
        await openTrove({ ICR: toBN(dec(4, 18)), extraLUSDAmount: spDeposit, extraParams: { from: whale } })
    
        // provide to SP so drip will mint interest
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: whale })
    
        await openTrove({ ICR: toBN(dec(190, 16)), extraParams: { from: defaulter_1 } })
        await openTrove({ ICR: toBN(dec(180, 16)), extraParams: { from: defaulter_2 } })
        await openTrove({ ICR: toBN(dec(195, 16)), extraParams: { from: defaulter_3 } })
        await openTrove({ ICR: toBN(dec(192, 16)), extraParams: { from: defaulter_4 } })
    
    
        for (let i = 0; i < 100; i++) {
          await th.fastForwardTime(timeValues.SECONDS_IN_ONE_YEAR, web3.currentProvider)
          await troveManager.drip()
    
          debt = await contracts.troveManager.getEntireSystemDebt(await contracts.troveManager.accumulatedRate(), await contracts.troveManager.accumulatedShieldRate())
          supply = await contracts.lusdToken.totalSupply()
    
          // amounts that aren't minted yet
          pendingSP = await contracts.stabilityPool.pendingLUSDDeposits()
          pendingLP = await contracts.globalFeeRouter.pendingLpDistribution()
          pendingStaker = await contracts.globalFeeRouter.pendingStakerDistribution()
    
          supplyVirtual = pendingSP.add(pendingLP).add(pendingStaker)
          supplyPlusVirtual = supply.add(supplyVirtual)
    
          // debt equals supply plus virtual
          assert.isTrue(supplyPlusVirtual.eq(debt))
    
          whale_debt = await contracts.troveManager.getTroveActualDebt(whale)
          trove_1_debt = await contracts.troveManager.getTroveActualDebt(defaulter_1)
          trove_2_debt = await contracts.troveManager.getTroveActualDebt(defaulter_2)
          trove_3_debt = await contracts.troveManager.getTroveActualDebt(defaulter_3)
          trove_4_debt = await contracts.troveManager.getTroveActualDebt(defaulter_4)
    
          trove_debt_sum = whale_debt.add(trove_1_debt).add(trove_2_debt).add(trove_3_debt).add(trove_4_debt)
          // allow at most divergence of 1 per trove
          assert.isTrue(supplyPlusVirtual.sub(trove_debt_sum).lte(toBN('4')))
        }
      })
    
    })
})