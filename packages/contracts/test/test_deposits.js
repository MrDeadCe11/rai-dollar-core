const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const LiquidationsTester = artifacts.require("./LiquidationsTester.sol")
const RateControlTester = artifacts.require("./RateControlTester.sol")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const FeeRouterTester = artifacts.require("./FeeRouterTester.sol")
const StabilityPoolTester = artifacts.require("./StabilityPoolTester.sol")

const { dec, toBN } = testHelpers.TestHelper
const th = testHelpers.TestHelper

contract('StabilityPool - Withdrawal of stability deposit - Reward calculations', async accounts => {

  const [owner,
    defaulter_1,
    defaulter_2,
    defaulter_3,
    defaulter_4,
    defaulter_5,
    defaulter_6,
    whale,
    // whale_2,
    alice,
    bob,
    carol,
    dennis,
    erin,
    flyn,
    graham,
    harriet,
    A,
    B,
    C,
    D,
    E,
    F
  ] = accounts;

  const [bountyAddress, lpRewardsAddress, multisig] = accounts.slice(997, 1000)

  let contracts

  let priceFeed
  let lusdToken
  let sortedTroves
  let troveManager
  let activePool
  let stabilityPool
  let defaultPool
  let borrowerOperations
  let collateralToken
  let relayer
  let feeRouter

  let gasPriceInWei

  const ZERO_ADDRESS = th.ZERO_ADDRESS

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const assertRevert = th.assertRevert

  describe("Stability Pool Withdrawal", async () => {

    before(async () => {
      gasPriceInWei = await web3.eth.getGasPrice()
    })

    beforeEach(async () => {
      contracts = await deploymentHelper.deployLiquityCore()
      const LQTYContracts = await deploymentHelper.deployLQTYContracts(bountyAddress, lpRewardsAddress, multisig)
      contracts.liquidations = await LiquidationsTester.new()
      contracts.troveManager = await TroveManagerTester.new()
      contracts.rateControl = await RateControlTester.new()
      contracts.feeRouter = await FeeRouterTester.new()
      contracts.stabilityPool = await StabilityPoolTester.new()
      contracts = await deploymentHelper.deployLUSDToken(contracts)

      priceFeed = contracts.priceFeedTestnet
      lusdToken = contracts.lusdToken
      sortedTroves = contracts.sortedTroves
      liquidations = contracts.liquidations
      troveManager = contracts.troveManager
      activePool = contracts.activePool
      stabilityPool = contracts.stabilityPool
      defaultPool = contracts.defaultPool
      borrowerOperations = contracts.borrowerOperations
      collateralToken = contracts.collateralToken
      relayer = contracts.relayer
      feeRouter = contracts.feeRouter
      rateControl = contracts.rateControl

      await th.batchMintCollateralTokensAndApproveActivePool(contracts, [owner,
        defaulter_1,
        defaulter_2,
        defaulter_3,
        defaulter_4,
        defaulter_5,
        defaulter_6,
        whale,
        // whale_2,
        alice,
        bob,
        carol,
        dennis,
        erin,
        flyn,
        graham,
        harriet,
        A,
        B,
        C,
        D,
        E,
        F
      ], dec(2, 29))
      await deploymentHelper.connectLQTYContracts(LQTYContracts)
      await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)
    })
    it("simulate", async () => {
      //await rateControl.setCoBias(0)
      feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
      stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;

      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      total = spDeposit.add(spDeposit).add(spDeposit)
      console.log("sum of deposits before liq", total.toString())
      console.log("totalLUSD before liq", (await stabilityPool.getTotalLUSDDeposits()).toString())

      // simulate liquidation #2
      tx1 = await stabilityPool.setOffset(toBN('10000000222997006880253'), toBN('10000000000000000000000'), toBN('99500000000000000000'), toBN(0), toBN(0), toBN(0));
      errorOffset = await stabilityPool.lastLUSDLossError_Offset()
      console.log("errorOffset " + errorOffset)

      LUSDLossPerUnitStaked = th.getRawEventArgByName(tx1, stabilityPoolInterface, stabilityPool.address, "Offset", "lusdLoss");
      console.log("SP Offset.LUSDLossPerUnitStaked " + LUSDLossPerUnitStaked)

      aliceDeposit1 = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit1 = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit1 = await stabilityPool.getCompoundedLUSDDeposit(carol)
      sum1 = aliceDeposit1.add(bobDeposit1).add(carolDeposit1)
      totalLUSD1 = await stabilityPool.getTotalLUSDDeposits()
      diff1 = totalLUSD1.sub(sum1)
      console.log("sum of deposits after liq1 " + sum1)
      console.log("totalLUSD after liq1 " + totalLUSD1)
      console.log("diff after liq1 " + diff1)

      console.log("-----------------------")


      // simulate liquidation #2
      tx2 = await stabilityPool.setOffset(toBN('10000000224578545953900'), toBN('10000000000000000000000'), toBN('99500000000000000000'), toBN(0), toBN(0), toBN(0));
      errorOffset = await stabilityPool.lastLUSDLossError_Offset()
      console.log("errorOffset " + errorOffset)

      LUSDLossPerUnitStaked = th.getRawEventArgByName(tx2, stabilityPoolInterface, stabilityPool.address, "Offset", "lusdLoss");
      console.log("SP Offset.LUSDLossPerUnitStaked " + LUSDLossPerUnitStaked)

      aliceDeposit2 = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit2 = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit2 = await stabilityPool.getCompoundedLUSDDeposit(carol)
      sum2 = aliceDeposit2.add(bobDeposit2).add(carolDeposit2)
      totalLUSD2 = await stabilityPool.getTotalLUSDDeposits()
      diff2 = totalLUSD2.sub(sum2)
      console.log("sum of deposits after liq2 " + sum2)
      console.log("totalLUSD after liq2 " + totalLUSD2)
      console.log("diff after liq2 " + diff2)

    })
    it("check sum of deposits gt total deposits", async () => {
      //await rateControl.setCoBias(0)
      feeRouterInterface = (await ethers.getContractAt("FeeRouter", feeRouter.address)).interface;
      stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", stabilityPool.address)).interface;

      //random time passsed
      //randTime = 183 // this time fails with drip in liqudiations
      //randTime = 374
      randTime = th.randNumber(20, 1000)
      console.log("randTime " + randTime)
      await th.fastForwardTime(randTime, web3.currentProvider)

      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }


      total = spDeposit.add(spDeposit).add(spDeposit)
      console.log("sum of deposits before liq", total.toString())
      console.log("totalLUSD before liq", (await stabilityPool.getTotalLUSDDeposits()).toString())
      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      console.log("-----------------------")
      // First two defaulters liquidated, 2/3 of SP, 10000/3 left
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });

      //(uint actualBaseDebt, uint baseDebt, uint baseColl, uint actualShieldedDebt, uint shieldedDebt, uint shieldedColl);
      
      actualBaseDebt = th.getEventArgByName(tx1, 'Offset', 'actualBaseDebt').toString()
      baseDebt = th.getEventArgByName(tx1, 'Offset', 'baseDebt').toString()
      baseColl = th.getEventArgByName(tx1, 'Offset', 'baseColl').toString()
      actualShieldedDebt = th.getEventArgByName(tx1, 'Offset', 'actualShieldedDebt').toString()
      shieldedDebt = th.getEventArgByName(tx1, 'Offset', 'shieldedDebt').toString()
      shieldedColl = th.getEventArgByName(tx1, 'Offset', 'shieldedColl').toString()

      console.log(actualBaseDebt, baseDebt, baseColl, actualShieldedDebt, shieldedDebt, shieldedColl)

      errorOffset = await stabilityPool.lastLUSDLossError_Offset()
      console.log("errorOffset " + errorOffset)

      LUSDLossPerUnitStaked1 = th.getRawEventArgByName(tx1, stabilityPoolInterface, stabilityPool.address, "Offset", "lusdLoss");
      console.log("SP Offset.LUSDLossPerUnitStaked1 " + LUSDLossPerUnitStaked1)

      aliceDeposit1 = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit1 = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit1 = await stabilityPool.getCompoundedLUSDDeposit(carol)
      sum1 = aliceDeposit1.add(bobDeposit1).add(carolDeposit1)
      totalLUSD1 = await stabilityPool.getTotalLUSDDeposits()
      diff1 = totalLUSD1.sub(sum1)
      console.log("sum of deposits after liq1 " + sum1)
      console.log("totalLUSD after liq1 " + totalLUSD1)
      console.log("diff after liq1 " + diff1)

      console.log("-----------------------")

      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });


      actualBaseDebt = th.getEventArgByName(tx2, 'Offset', 'actualBaseDebt').toString()
      baseDebt = th.getEventArgByName(tx2, 'Offset', 'baseDebt').toString()
      baseColl = th.getEventArgByName(tx2, 'Offset', 'baseColl').toString()
      actualShieldedDebt = th.getEventArgByName(tx2, 'Offset', 'actualShieldedDebt').toString()
      shieldedDebt = th.getEventArgByName(tx2, 'Offset', 'shieldedDebt').toString()
      shieldedColl = th.getEventArgByName(tx2, 'Offset', 'shieldedColl').toString()
      console.log(actualBaseDebt, baseDebt, baseColl, actualShieldedDebt, shieldedDebt, shieldedColl)

      errorOffset = await stabilityPool.lastLUSDLossError_Offset()
      console.log("errorOffset " + errorOffset)

      LUSDLossPerUnitStaked2 = th.getRawEventArgByName(tx2, stabilityPoolInterface, stabilityPool.address, "Offset", "lusdLoss");
      console.log("SP Offset.LUSDLossPerUnitStaked2 " + LUSDLossPerUnitStaked2)

      aliceDeposit2 = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit2 = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit2 = await stabilityPool.getCompoundedLUSDDeposit(carol)
      sum2 = aliceDeposit2.add(bobDeposit2).add(carolDeposit2)
      totalLUSD2 = await stabilityPool.getTotalLUSDDeposits()
      diff2 = totalLUSD2.sub(sum2)
      console.log("sum of deposits after liq2 " + sum2)
      console.log("totalLUSD after liq2 " + totalLUSD2)
      console.log("diff after liq2 " + diff2)
      assert.isTrue(diff2.gt(toBN(0)))
    })
  })
})

contract('Reset chain state', async accounts => { })
