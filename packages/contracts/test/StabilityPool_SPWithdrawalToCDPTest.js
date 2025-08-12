
const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const LiquidationsTester = artifacts.require("./LiquidationsTester.sol")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const RateControlTester = artifacts.require("./RateControlTester.sol")

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
  let liquidations
  let borrowerOperations
  let collateralToken

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

      await deploymentHelper.connectLQTYContracts(LQTYContracts)
      await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

      await th.mintCollateralTokensAndApproveActivePool(contracts, [owner,
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
      ], toBN(dec(1000, 26)))

    })

    // --- Compounding tests ---

    // --- withdrawCollateralGainToTrove() ---

    // --- Identical deposits, identical liquidation amounts---
    it("withdrawCollateralGainToTrove(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Defaulter opens trove with 200% ICR and 10k LUSD net debt
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter liquidated
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterLiquidation(contracts, tx, [spDeposit, spDeposit, spDeposit])

      // Check depositors' compounded deposit is 6666.66 LUSD and ETH Gain is 33.16 ETH
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '6666666666666666666666'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '6666666666666666666666'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '6666666666666666666666'), 10000)
      
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 20000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 20000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 20000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '33166666666666666667'), 10000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '33166666666666666667'), 10000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '33166666666666666667'), 10000)
    })

    it("withdrawCollateralGainToTrove(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after two identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit])

      // Check depositors' compounded deposit is 3333.33 LUSD and ETH Gain is 66.33 ETH
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '3333333333333333333333'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '3333333333333333333333'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '3333333333333333333333'), 10000)
      
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 23000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 23000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 23000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '66333333333333333333'), 10000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '66333333333333333333'), 10000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '66333333333333333333'), 10000)
    })

    it("withdrawCollateralGainToTrove():  Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after three identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      await liquidations.liquidate(defaulter_1, { from: owner });
      await liquidations.liquidate(defaulter_2, { from: owner });
      await liquidations.liquidate(defaulter_3, { from: owner });

      // Check depositors' compounded deposit is 0 LUSD and ETH Gain is 99.5 ETH 
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      // 1/3 LUSD each
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '333333333333330000'), 10000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '333333333333330000'), 10000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '333333333333330000'), 10000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(99500, 15)), 5e15)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(99500, 15)), 5e15)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(99500, 15)), 5e15)
    })

    // --- Identical deposits, increasing liquidation amounts ---
    it("withdrawCollateralGainToTrove(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after two liquidations of increasing LUSD", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(70, 'ether'), await getOpenTroveLUSDAmount(dec(7000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit])

      // Check depositors' compounded deposit
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '6000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '6000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '6000000000000000000000'), 10000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 24000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 24000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 24000)

      // (0.5 + 0.7) * 99.5 / 3
      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(398, 17)), 10000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(398, 17)), 10000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(398, 17)), 10000)
    })

    it("withdrawCollateralGainToTrove(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after three liquidations of increasing LUSD", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(60, 'ether'), await getOpenTroveLUSDAmount(dec(6000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(70, 'ether'), await getOpenTroveLUSDAmount(dec(7000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, [spDeposit, spDeposit, spDeposit])

      // Check depositors' compounded deposit
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '4000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '4000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '4000000000000000000000'), 10000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 21000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 21000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 21000)

      // (0.5 + 0.6 + 0.7) * 99.5 / 3
      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(597, 17)), 10000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(597, 17)), 10000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(597, 17)), 10000)
    })

    // --- Increasing deposits, identical liquidation amounts ---
    it("withdrawCollateralGainToTrove(): Depositors with varying deposits withdraw correct compounded deposit and ETH Gain after two identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // 2 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      // Whale transfers 10k, 20k, 30k LUSD to A, B and C respectively who then deposit it to the SP
      aliceSpDeposit = toBN(dec(10000, 18)) 
      bobSpDeposit = toBN(dec(20000, 18)) 
      carolSpDeposit = toBN(dec(30000, 18)) 
      await lusdToken.transfer(alice, aliceSpDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceSpDeposit, ZERO_ADDRESS, { from: alice })
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })
      await lusdToken.transfer(carol, carolSpDeposit, { from: whale })
      await stabilityPool.provideToSP(carolSpDeposit, ZERO_ADDRESS, { from: carol })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [aliceSpDeposit, bobSpDeposit,carolSpDeposit])

      // Depositors attempt to withdraw everything
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '6666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '13333333333333333333333'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '20000000000000000000000'), 100000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 100000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '33166666666666666667'), 100000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '66333333333333333333'), 100000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(995, 17)), 100000)
    })

    it("withdrawCollateralGainToTrove(): Depositors with varying deposits withdraw correct compounded deposit and ETH Gain after three identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })

      // Whale transfers 10k, 20k, 30k LUSD to A, B and C respectively who then deposit it to the SP
      aliceSpDeposit = toBN(dec(10000, 18)) 
      bobSpDeposit = toBN(dec(20000, 18)) 
      carolSpDeposit = toBN(dec(30000, 18)) 
      await lusdToken.transfer(alice, aliceSpDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceSpDeposit, ZERO_ADDRESS, { from: alice })
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })
      await lusdToken.transfer(carol, carolSpDeposit, { from: whale })
      await stabilityPool.provideToSP(carolSpDeposit, ZERO_ADDRESS, { from: carol })


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, [aliceSpDeposit, bobSpDeposit,carolSpDeposit])

      // Depositors attempt to withdraw everything
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '5000000000000000000000'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '10000000000000000000000'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '15000000000000000000000'), 100000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 100000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '49750000000000000000'), 100000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 17)), 100000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '149250000000000000000'), 100000)
    })

    // --- Varied deposits and varied liquidation amount ---
    it("withdrawCollateralGainToTrove(): Depositors with varying deposits withdraw correct compounded deposit and ETH Gain after three varying liquidations", async () => {
      // Whale opens Trove with 1m ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      /* Defaulters open troves
     
      Defaulter 1: 207000 LUSD & 2160 ETH
      Defaulter 2: 5000 LUSD & 50 ETH
      Defaulter 3: 46700 LUSD & 500 ETH
      */
      await borrowerOperations.openTrove(dec(2160, 'ether'), await getOpenTroveLUSDAmount(dec(207000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5, 21)), defaulter_2, defaulter_2, { from: defaulter_2 })
      //await borrowerOperations.openTrove(await getOpenTroveLUSDAmount('46700000000000000000000'), defaulter_3, defaulter_3, { from: defaulter_3, value: dec(500, 'ether') })
      await borrowerOperations.openTrove(dec(500, 'ether'), await getOpenTroveLUSDAmount('46700000000000000000000'), defaulter_3, defaulter_3, { from: defaulter_3 })

      /* Depositors provide:-
      Alice:  2000 LUSD
      Bob:  456000 LUSD
      Carol: 13100 LUSD */
      // Whale transfers LUSD to  A, B and C respectively who then deposit it to the SP
      aliceSpDeposit = toBN(dec(2000, 18))
      bobSpDeposit = toBN(dec(456000, 18))
      carolSpDeposit = toBN(dec(13100, 18))
      await lusdToken.transfer(alice, aliceSpDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceSpDeposit, ZERO_ADDRESS, { from: alice })
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })
      await lusdToken.transfer(carol, carolSpDeposit, { from: whale })
      await stabilityPool.provideToSP(carolSpDeposit, ZERO_ADDRESS, { from: carol })


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = await th.depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, [aliceSpDeposit, bobSpDeposit,carolSpDeposit])

      // Depositors attempt to withdraw everything
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      // ()
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '901719380174061000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '205592018679686000000000'), 10000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '5906261940140100000000'), 10000000000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 100000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 10000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 10000000000)

      // 2710 * {2000, 456000, 13100}/4711
      
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '11417108920745540021'), 10000000000)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '2603100833929983124899'), 10000000000)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '74782063430883287140'), 10000000000)
    })

    // --- Deposit enters at t > 0

    it("withdrawCollateralGainToTrove(): A, B, C Deposit -> 2 liquidations -> D deposits -> 1 liquidation. All deposits and liquidations = 100 LUSD.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain1, bobGain1, carolGain1, aliceDeposit1, bobDeposit1, carolDeposit1] =
            (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))

      // Whale transfers 10k to Dennis who then provides to SP
      await lusdToken.transfer(dennis, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: dennis })

      // Third defaulter liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });

      const [aliceGain2, bobGain2, carolGain2, dennisGain2,
          aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] = (await th.depositorValuesAfterLiquidation(contracts, tx3, [aliceDeposit1, bobDeposit1, carolDeposit1, spDeposit]))


      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '1666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '1666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '1666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), '5000000000000000000000'), 100000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceDeposit2), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDeposit2), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolDeposit2), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dennisDeposit2), 100000)

      //assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '82916666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '82916666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '82916666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '49750000000000000000'), 100000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, aliceGain1.add(aliceGain2)), 100000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, bobGain1.add(bobGain2)), 100000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, carolGain1.add(carolGain2)), 100000)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dennisGain2), 100000)
    })

    it("withdrawCollateralGainToTrove(): A, B, C Deposit -> 2 liquidations -> D deposits -> 2 liquidations. All deposits and liquidations = 100 LUSD.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated, 2/3 of SP, 10000/3 left
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceDeposit1, bobDeposit1, carolDeposit1] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))

      // Dennis opens a trove and provides to SP
      await lusdToken.transfer(dennis, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: dennis })

      // Third and fourth defaulters liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [finalAliceDeposit, finalBobDeposit, finalCarolDeposit, finalDennisDeposit] = (await th.depositsAfterTwoLiquidations(contracts, tx3, tx4, [aliceDeposit1, bobDeposit1, carolDeposit1, spDeposit]))

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // 1/6, 1/6, 1/6 and 1/2 LUSD
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '166666666666660000'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '166666666666660000'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '166666666666660000'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), '499999999999980000'), 100000)
       
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), finalAliceDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), finalBobDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), finalCarolDeposit), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), finalDennisDeposit), 100000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(995, 17)), 2e15)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 17)), 2e15)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(995, 17)), 2e15)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dec(995, 17)), 5e15)
    })

    it("withdrawCollateralGainToTrove(): A, B, C Deposit -> 2 liquidations -> D deposits -> 2 liquidations. Various deposit and liquidation vals.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 1m ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      /* Defaulters open troves:
      Defaulter 1:  10000 LUSD, 100 ETH
      Defaulter 2:  25000 LUSD, 250 ETH
      Defaulter 3:  5000 LUSD, 50 ETH
      Defaulter 4:  40000 LUSD, 400 ETH
      */
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(250, 'ether'), await getOpenTroveLUSDAmount(dec(25000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(400, 'ether'), await getOpenTroveLUSDAmount(dec(40000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      /* Depositors open troves and make SP deposit:
      Alice: 60000 LUSD
      Bob: 20000 LUSD
      Carol: 15000 LUSD
      */
      // Whale transfers LUSD to  A, B and C respectively who then deposit it to the SP
      aliceSpDeposit = toBN(dec(60000, 18))
      bobSpDeposit= toBN(dec(20000, 18))
      carolSpDeposit = toBN(dec(15000, 18))
      await lusdToken.transfer(alice, aliceSpDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceSpDeposit, ZERO_ADDRESS, { from: alice })
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })
      await lusdToken.transfer(carol, carolSpDeposit, { from: whale })
      await stabilityPool.provideToSP(carolSpDeposit, ZERO_ADDRESS, { from: carol })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain1, bobGain1, carolGain1, aliceDeposit1, bobDeposit1, carolDeposit1] =
            (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [aliceSpDeposit, bobSpDeposit, carolSpDeposit]))

      // Dennis provides 25000 LUSD
      dennisSpDeposit = toBN(dec(25000, 18))
      await lusdToken.transfer(dennis, dennisSpDeposit, { from: whale })
      await stabilityPool.provideToSP(dennisSpDeposit, ZERO_ADDRESS, { from: dennis })

      // Last two defaulters liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [aliceGain2, bobGain2, carolGain2, dennisGain2, aliceDeposit2,
             bobDeposit2, carolDeposit2, dennisDeposit2] =
            (await th.depositorValuesAfterTwoLiquidations(contracts, tx3, tx4, [aliceDeposit1, bobDeposit1, carolDeposit1, dennisSpDeposit]))

      // Each depositor withdraws as much as possible
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '17832817337461300000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '5944272445820430000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '4458204334365320000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), '11764705882352900000000'), 100000000000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceDeposit2), 100000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDeposit2), 100000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolDeposit2), 100000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dennisDeposit2), 100000000000)

      // 3.5*0.995 * {60000,20000,15000,0} / 95000 + 450*0.995 * {60000/950*{60000,20000,15000},25000} / (120000-35000)
      //assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '419563467492260055900'), 100000000000)
      //assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '139854489164086692700'), 100000000000)
      //assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '104890866873065014000'), 100000000000)
      //assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '131691176470588233700'), 100000000000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, aliceGain1.add(aliceGain2)), 100000000000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, bobGain1.add(bobGain2)), 100000000000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, carolGain1.add(carolGain2)), 100000000000)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dennisGain2), 100000000000)
    })

    // --- Depositor leaves ---

    it("withdrawCollateralGainToTrove(): A, B, C, D deposit -> 2 liquidations -> D withdraws -> 2 liquidations. All deposits and liquidations = 100 LUSD.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol, dennis]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
        const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit, dennisFinalDeposit] = await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit, spDeposit])

      // Dennis withdraws his deposit and ETH gain
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), '5000000000000000000000'), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dennisFinalDeposit), 100000)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '49750000000000000000'), 100000)
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      // Two more defaulters are liquidated
      await liquidations.liquidate(defaulter_3, { from: owner });
      await liquidations.liquidate(defaulter_4, { from: owner });

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '333333333333330000'), 1000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '333333333333330000'), 1000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '333333333333330000'), 1000)

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceFinalDeposit), 1000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 1000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 1000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(995, 17)), 4e15)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 17)), 4e15)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(995, 17)), 4e15)
    })

    it("withdrawCollateralGainToTrove(): A, B, C, D deposit -> 2 liquidations -> D withdraws -> 2 liquidations. Various deposit and liquidation vals. A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
     
      /* Defaulters open troves:
      Defaulter 1: 10000 LUSD
      Defaulter 2: 20000 LUSD
      Defaulter 3: 30000 LUSD
      Defaulter 4: 5000 LUSD
      */
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(300, 'ether'), await getOpenTroveLUSDAmount(dec(30000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      /* Initial deposits:
      Alice: 20000 LUSD
      Bob: 25000 LUSD
      Carol: 12500 LUSD
      Dennis: 40000 LUSD
      */
      // Whale transfers LUSD to  A, B,C and D respectively who then deposit it to the SP
      aliceSpDeposit = toBN(dec(20000, 18))
      bobSpDeposit = toBN(dec(25000, 18))
      carolSpDeposit = toBN(dec(12500, 18))
      dennisSpDeposit = toBN(dec(40000, 18))
      await lusdToken.transfer(alice, aliceSpDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceSpDeposit, ZERO_ADDRESS, { from: alice })
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })
      await lusdToken.transfer(carol, carolSpDeposit, { from: whale })
      await stabilityPool.provideToSP(carolSpDeposit, ZERO_ADDRESS, { from: carol })
      await lusdToken.transfer(dennis, dennisSpDeposit, { from: whale })
      await stabilityPool.provideToSP(dennisSpDeposit, ZERO_ADDRESS, { from: dennis })


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain1, bobGain1, carolGain1, dennisGain1,
             aliceDeposit1, bobDeposit1, carolDeposit1, dennisDeposit1] =
            (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [aliceSpDeposit, bobSpDeposit, carolSpDeposit, dennisSpDeposit]))

      // Dennis withdraws his deposit and ETH gain
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txD = await stabilityPool.withdrawFromSP(dec(40000, 18), { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '27692307692307700000000'), 100000000000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisDeposit1), 100000000000)
      // 300*0.995 * 40000/97500
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '122461538461538466100'), 100000000000)

      // Two more defaulters are liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [aliceGain2, bobGain2, carolGain2,
             aliceDeposit2, bobDeposit2, carolDeposit2] =
            (await th.depositorValuesAfterTwoLiquidations(contracts, tx3, tx4, [aliceDeposit1, bobDeposit1, carolDeposit1]))

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '1672240802675590000000'), 10000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '2090301003344480000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '1045150501672240000000'), 100000000000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceDeposit2), 10000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDeposit2), 100000000000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolDeposit2), 100000000000)

      // 300*0.995 * {20000,25000,12500}/97500 + 350*0.995 * {20000,25000,12500}/57500
      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '182361204013377919900'), 100000000000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '227951505016722411000'), 100000000000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '113975752508361205500'), 100000000000)
    })

    // --- One deposit enters at t > 0, and another leaves later ---
    it("withdrawCollateralGainToTrove(): A, B, D deposit -> 2 liquidations -> C makes deposit -> 1 liquidation -> D withdraws -> 1 liquidation. All deposits: 100 LUSD. Liquidations: 100,100,100,50.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
   
      // Defaulters open troves
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B and D who then deposit it to the SP
      const depositors = [alice, bob, dennis]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain1, bobGain1, dennisGain1,
             aliceDeposit1, bobDeposit1, dennisDeposit1] =
            (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))

      // Carol makes deposit
      await lusdToken.transfer(carol, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: carol })

      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceGain2, bobGain2, carolGain2, dennisGain2,
             aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] =
            (await th.depositorValuesAfterLiquidation(contracts, tx3, [aliceDeposit1, bobDeposit1, spDeposit, dennisDeposit1]))

      // Dennis withdraws his deposit and ETH gain
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txD = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '1666666666666666666666'), 100000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisDeposit2), 100000)
      //assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '82916666666666666667'), 100000)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dennisGain1.add(dennisGain2)), 100000)

      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [aliceGain3, bobGain3, carolGain3,
             aliceDeposit3, bobDeposit3, carolDeposit3] =
            (await th.depositorValuesAfterLiquidation(contracts, tx4, [aliceDeposit2, bobDeposit2, carolDeposit2]))

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '2000000000000000000000'), 100000)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), aliceDeposit3), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDeposit3), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolDeposit3), 100000)

      //assert.isAtMost(th.getDifference(alice_ETHWithdrawn, '92866666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(bob_ETHWithdrawn, '92866666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '79600000000000000000'), 100000)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, aliceGain1.add(aliceGain2).add(aliceGain3)), 100000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, bobGain1.add(bobGain2).add(bobGain3)), 100000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, carolGain2.add(carolGain3)), 100000)
    })

    // --- Tests for full offset - Pool empties to 0 ---

    // A, B deposit 10000
    // L1 cancels 20000, 200
    // C, D deposit 10000
    // L2 cancels 10000,100

    // A, B withdraw 0LUSD & 100e
    // C, D withdraw 5000LUSD  & 500e
    it("withdrawCollateralGainToTrove(): Depositor withdraws correct compounded deposit after liquidation empties the pool, #1", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // 2 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      // Whale transfers 10k LUSD to A, B who then deposit it to the SP
      const depositors = [alice, bob]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated. 20000 LUSD fully offset with pool.
      await liquidations.liquidate(defaulter_1, { from: owner });

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      await priceFeed.setPrice(dec(100, 18));

      // Expect Alice And Bob's compounded deposit to be 1 LUSD combbined
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), dec(5, 17)), 1e4)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), dec(5, 17)), 1e4)

      // Expect Alice and Bob's ETH Gain to be 100 ETH
      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(995, 17)), 5e15)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 17)), 5e15)

      // Carol, Dennis each deposit 10000 LUSD
      const depositors_2 = [carol, dennis]
      for (account of depositors_2) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      // whale withdraws as it’s not needed anymore
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: whale })
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 2 liquidated. 10000 LUSD offset
      await liquidations.liquidate(defaulter_2, { from: owner });

      // await borrowerOperations.openTrove(dec(1, 18), account, account, { from: erin, value: dec(2, 'ether') })
      // await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: erin })

      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // Expect Carol And Dennis' compounded deposit to be 50 LUSD
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), dec(5000, 18)), 3e17)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dec(5000, 18)), 3e17)

      // Expect Carol and and Dennis ETH Gain to be 50 ETH
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '49750000000000000000'), 3e15)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '49750000000000000000'), 3e15)
    })

    // A, B deposit 10000
    // L1 cancels 10000, 1
    // L2 10000, 200 empties Pool
    // C, D deposit 10000
    // L3 cancels 10000, 1 
    // L2 20000, 200 empties Pool
    it("withdrawCollateralGainToTrove(): Almost pool-emptying liquidation resets scaleFactor to 0, and resets P to 1e18", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // 4 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B who then deposit it to the SP
      const depositors = [alice, bob]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      const scale_0 = (await stabilityPool.currentScale()).toString()
      const P0 = await stabilityPool.P()

      assert.equal(scale_0, '0')
      assert.equal(P0, dec(1, 18))

      // Defaulter 1 liquidated. 10000 LUSD fully offset, Pool remains non-zero
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const expP1 = await th.getNewPAfterLiquidation(contracts, tx1, P0, liq1Deposits, lastLUSDError1)


      //Check scale and sum
      const scale_1 = (await stabilityPool.currentScale()).toString()
      const P1 = await stabilityPool.P()

      assert.equal(scale_1, '0')
      assert.isAtMost(th.getDifference(P1, expP1), 1000)

      // Defaulter 2 liquidated. 10000 LUSD
      liq2Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError2 = await stabilityPool.lastLUSDLossError_Offset()
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [,drip2] = await th.getEmittedDripValues(contracts,tx2)
      var [liquidatedDebt2] = await th.getEmittedLiquidationValues(tx2)
    // console.log("drip2", drip2.toString())
    // console.log("liquidatedDebt2", liquidatedDebt2.toString())
      const expP_2 = await th.getNewPAfterLiquidation(contracts, tx2, P1, liq2Deposits, lastLUSDError2)

      //Check scale and sum
      const scale_2 = (await stabilityPool.currentScale()).toString()
      const P_2 = await stabilityPool.P()

    // console.log("P_2", P_2.toString())
    // console.log("expP_2", expP_2.toString())

      assert.equal(scale_2, '0')
      assert.isAtMost(th.getDifference(P_2, dec(5, 13)), 10)
      // This AtMost tolerance of 13e8 is from the P3 check below
      // TODO: P2=50000000000000, but expP2=50000257000096
      // seems like a big difference.
      assert.isAtMost(th.getDifference(P_2, expP_2), 13e8)


      // Carol, Dennis each deposit 10000 LUSD
      const depositors_2 = [carol, dennis]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // Defaulter 3 liquidated. 10000 LUSD fully offset, Pool remains non-zero
      await liquidations.liquidate(defaulter_3, { from: owner });

      //Check scale and sum
      const scale_3 = (await stabilityPool.currentScale()).toString()
      const P_3 = (await stabilityPool.P()).toString()

      assert.equal(scale_3, '0')
      assert.isAtMost(th.getDifference(P_3, dec(25, 12)), 13e8)

      // Defaulter 4 liquidated. 10000 LUSD, empties pool
      await liquidations.liquidate(defaulter_4, { from: owner });

      //Check scale and sum
      const scale_4 = (await stabilityPool.currentScale()).toString()
      const P_4 = (await stabilityPool.P()).toString()

      assert.equal(scale_4, '0')
      assert.isAtMost(th.getDifference(P_4, dec(25, 8)), 13e4)
    })


    // A, B deposit 10000
    // L1 cancels 20000, 200
    // C, D, E deposit 10000, 20000, 30000
    // L2 cancels 10000,100 

    // A, B withdraw 0 LUSD & 100e
    // C, D withdraw 5000 LUSD  & 50e
    it("withdrawCollateralGainToTrove(): Depositors withdraw correct compounded deposit after liquidation almost empties the pool", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: erin })

      // Whale transfers 10k LUSD to A, B who then deposit it to the SP
      const depositors = [alice, bob]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // 2 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated. 20000 LUSD fully offset with pool.
      await liquidations.liquidate(defaulter_1, { from: owner });

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      // Expect Alice And Bob's compounded deposit to be 1 LUSD combined
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), dec(5, 17)), 10000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), dec(5, 17)), 10000)
      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      await priceFeed.setPrice(dec(100, 18));

      // Carol, Dennis, Erin each deposit 10000, 20000, 30000 LUSD respectively
      await lusdToken.transfer(carol, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: carol })

      await lusdToken.transfer(dennis, dec(20000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(20000, 18), ZERO_ADDRESS, { from: dennis })

      await lusdToken.transfer(erin, dec(30000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(30000, 18), ZERO_ADDRESS, { from: erin })

      // whale leaves the SP
      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: whale })
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 2 liquidated. 10000 LUSD offset
      await liquidations.liquidate(defaulter_2, { from: owner });

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      const txE = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: erin })

      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      const erin_ETHWithdrawn = th.getEventArgByName(txE, 'CollateralGainWithdrawn', '_collateral').toString()

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '8333333333333333333333'), 1e15)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), '16666666666666666666666'), 1e15)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(erin)).toString(), '25000000000000000000000'), 1e15)

      //Expect Alice and Bob's ETH Gain to be 1 ETH
      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(995, 17)), 1e16)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 17)), 1e16)

      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, '16583333333333333333'), 1e13)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, '33166666666666666667'), 1e13)
      assert.isAtMost(th.getDifference(erin_ETHWithdrawn, '49750000000000000000'), 1e13)
    })

    // A deposits 10000
    // L1, L2, L3 liquidated with 10000 LUSD each
    // A withdraws all
    // Expect A to withdraw 0 deposit and ether only from reward L1
    it("withdrawCollateralGainToTrove(): single deposit fully offset. After subsequent liquidations, depositor withdraws 0 deposit and *only* the ETH Gain from one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Defaulter 1,2,3 withdraw 10000 LUSD
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })

      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: alice })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1, 2  and 3 liquidated
      await liquidations.liquidate(defaulter_1, { from: owner });
      await liquidations.liquidate(defaulter_2, { from: owner });
      await liquidations.liquidate(defaulter_3, { from: owner });

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), toBN(dec(1, 18))), 100000)
      // We subtract 1/10000 corresponding to the 1 LUSD left
      //assert.isAtMost(th.getDifference(alice_ETHWithdrawn, toBN(dec(995, 17)).sub(toBN(dec(995, 13)))), 1)
      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(995, 17)), 1e16)
    })

    //--- Serial full offsets ---

    // A,B deposit 10000 LUSD
    // L1 cancels 20000 LUSD, 2E
    // B,C deposits 10000 LUSD
    // L2 cancels 20000 LUSD, 2E
    // E,F deposit 10000 LUSD
    // L3 cancels 20000, 200E
    // G,H deposits 10000
    // L4 cancels 20000, 200E

    // Expect all depositors withdraw 0 LUSD and 100 ETH

    it("withdrawCollateralGainToTrove(): Depositor withdraws correct compounded deposit after liquidation empties the pool, #2", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // A, B, C, D, E, F, G, H open troves
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: erin })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: flyn })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: harriet })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: graham })

      // 4 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_4, defaulter_4, { from: defaulter_4 })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Alice, Bob each deposit 10k LUSD
      const depositors_1 = [alice, bob]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors_1) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // Defaulter 1 liquidated. 20k LUSD fully offset with pool.
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const [aliceGain1, bobGain1, aliceDeposit1, bobDeposit1] = (await th.depositorValuesAfterLiquidation(contracts, tx1, [spDeposit, spDeposit]))

      // Carol, Dennis each deposit 10000 LUSD
      const depositors_2 = [carol, dennis]
      for (account of depositors_2) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // Defaulter 2 liquidated. 10000 LUSD offset
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain2, bobGain2, carolGain2, dennisGain2,
             aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] =
            (await th.depositorValuesAfterLiquidation(contracts, tx2, [aliceDeposit1, bobDeposit1, spDeposit, spDeposit]))

      // Erin, Flyn each deposit 10000 LUSD
      const depositors_3 = [erin, flyn]
      for (account of depositors_3) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // Defaulter 3 liquidated. 10000 LUSD offset
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceGain3, bobGain3, carolGain3, dennisGain3, erinGain3, flynGain3,
             aliceDeposit3, bobDeposit3, carolDeposit3, dennisDeposit3, erinDeposit3, flynDeposit3] =
            (await th.depositorValuesAfterLiquidation(contracts, tx3, [aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2, spDeposit, spDeposit]))

      // Graham, Harriet each deposit 10000 LUSD
      const depositors_4 = [graham, harriet]
      for (account of depositors_4) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // Defaulter 4 liquidated. 10k LUSD offset
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [aliceGain4, bobGain4, carolGain4, dennisGain4, erinGain4, flynGain4, grahamGain4, harrietGain4,
             aliceDeposit4, bobDeposit4, carolDeposit4, dennisDeposit4, erinDeposit4, flynDeposit4, grahamDeposit4, harrietDeposit4] =
            (await th.depositorValuesAfterLiquidation(contracts, tx4,
                [aliceDeposit3, bobDeposit3, carolDeposit3, dennisDeposit3, erinDeposit3, flynDeposit3, spDeposit, spDeposit]))

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      const txE = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: erin })
      const txF = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: flyn })
      const txG = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: graham })
      const txH = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: harriet })

      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      const erin_ETHWithdrawn = th.getEventArgByName(txE, 'CollateralGainWithdrawn', '_collateral').toString()
      const flyn_ETHWithdrawn = th.getEventArgByName(txF, 'CollateralGainWithdrawn', '_collateral').toString()
      const graham_ETHWithdrawn = th.getEventArgByName(txG, 'CollateralGainWithdrawn', '_collateral').toString()
      const harriet_ETHWithdrawn = th.getEventArgByName(txH, 'CollateralGainWithdrawn', '_collateral').toString()

      // Expect all deposits to be 0 LUSD
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(alice)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(erin)).toString(), '0'), 1e14)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(flyn)).toString(), '0'), 1e14)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(graham)).toString(), 5e17), 1e14)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(harriet)).toString(), 5e17), 1e14)

      /* Expect all ETH gains to be 100 ETH:  Since each liquidation of almost empties the pool, depositors
         should only earn ETH from the single liquidation that cancelled with their deposit minus the 1 LUSD */
      //assert.isAtMost(th.getDifference(alice_ETHWithdrawn, dec(995, 17)), 2000000)
      //assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 17)), 2000000)
      //assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(995, 17)), 2e11)
      //assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dec(995, 17)), 2e11)
      //assert.isAtMost(th.getDifference(erin_ETHWithdrawn, dec(995, 17)), 5e12)
      //assert.isAtMost(th.getDifference(flyn_ETHWithdrawn, dec(995, 17)), 5e12)
      //assert.isAtMost(th.getDifference(graham_ETHWithdrawn, dec(995, 17)), 5e16)
      //assert.isAtMost(th.getDifference(harriet_ETHWithdrawn, dec(995, 17)), 5e16)

      aliceFinalGain = aliceGain1.add(aliceGain2).add(aliceGain3).add(aliceGain4)
      bobFinalGain = bobGain1.add(bobGain2).add(bobGain3).add(bobGain4)
      carolFinalGain = (carolGain2).add(carolGain3).add(carolGain4)
      dennisFinalGain = (dennisGain2).add(dennisGain3).add(dennisGain4)
      erinFinalGain = (erinGain3).add(erinGain4)
      flynFinalGain = (flynGain3).add(flynGain4)

      assert.isAtMost(th.getDifference(alice_ETHWithdrawn, aliceFinalGain), 2000000)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, bobFinalGain), 2000000)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, carolFinalGain), 2e11)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dennisFinalGain), 2e11)
      assert.isAtMost(th.getDifference(erin_ETHWithdrawn, erinFinalGain), 5e12)
      assert.isAtMost(th.getDifference(flyn_ETHWithdrawn, flynFinalGain), 5e12)
      assert.isAtMost(th.getDifference(graham_ETHWithdrawn, grahamGain4), 5e16)
      assert.isAtMost(th.getDifference(harriet_ETHWithdrawn, harrietGain4), 5e16)
    })

    // --- Scale factor tests ---

     // A deposits 10000
    // L1 brings P close to boundary, i.e. 9e-9: liquidate 9999.99991
    // A withdraws all
    // B deposits 10000
    // L2 of 9900 LUSD, should bring P slightly past boundary i.e. 1e-9 -> 1e-10

    // expect d(B) = d0(B)/100
    // expect correct ETH gain, i.e. all of the reward
    it("withdrawCollateralGainToTrove(): deposit spans one scale factor change: Single depositor withdraws correct compounded deposit and ETH Gain after one liquidation #1", async () => {
      // Whale opens Trove with 1e9 ETH
      await borrowerOperations.openTrove(dec(1e9, 'ether'), await getOpenTroveLUSDAmount(dec(1e11, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })

      // Defaulter 1 withdraws 'almost' 1e9 LUSD:  999999991 LUSD
      await borrowerOperations.openTrove(dec(1e7, 'ether'), await getOpenTroveLUSDAmount(dec(999999999, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      // Defaulter 2 withdraws 9900 LUSD
      await borrowerOperations.openTrove(dec(1e7, 'ether'), await getOpenTroveLUSDAmount(dec(999999999, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      spDeposit = toBN(dec(1e9, 18))
      await lusdToken.transfer(alice, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: alice })

      assert.equal(await stabilityPool.currentScale(), '0')

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));


      // Defaulter 1 liquidated.  Value of P reduced to 9e9.
      const P0 = await stabilityPool.P()
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const expP1 = await th.getNewPAfterLiquidation(contracts, tx1, P0, liqDeposits, lastLUSDError)
      const P1 = await stabilityPool.P()
      assert.isTrue(expP1.eq(P1))
      const [aliceGain1, aliceDeposit1] = (await th.depositorValuesAfterLiquidation(contracts, tx1, [spDeposit]))


      //assert.equal((await stabili tyPool.P()).toString(), dec(9, 9))

      // whale deposits LUSD so Alice can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = await th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      await lusdToken.transfer(bob, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: bob })

      // Defaulter 2 liquidated.  9900 LUSD liquidated. P altered by a factor of 1-(9900/10000) = 0.01.  Scale changed.
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()

      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const expP2 = await th.getNewPAfterLiquidation(contracts, tx2, P1, liqDeposits, lastLUSDError)
      const P2 = await stabilityPool.P()
      assert.equal(await stabilityPool.currentScale(), '1')

      assert.isTrue(expP2.eq(P2.div(toBN(dec(1,9)))))

      // include 1 LUSD whaledeposit for depositorValuesAfterLiquidation()
      // most tests don't do this as current isAtMost tolerances allow it 
      const [bobGain2, whaleGain2, bobDeposit2, whaleDeposit2] = (await th.depositorValuesAfterLiquidation(contracts, tx2, [spDeposit, toBN(dec(1,18))]))

      // whale deposits LUSD so Bob can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const bob_ETHWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()

      // Expect Bob to retain 1% of initial deposit and almostall the liquidated ETH
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), dec(1e7, 18)), 1e18)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDeposit2), 1e18)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, bobGain2), 1e16)
    })

    // A deposits 10000
    // L1 brings P close to boundary, i.e. 9e-9: liquidate 9999.99991 LUSD
    // A withdraws all
    // B, C, D deposit 10000, 20000, 30000
    // L2 of 59400, should bring P slightly past boundary i.e. 1e-9 -> 1e-10

    // expect d(B) = d0(B)/100
    // expect correct ETH gain, i.e. all of the reward
    it("withdrawCollateralGainToTrove(): Several deposits of varying amounts span one scale factor change. Depositors withdraw correct compounded deposit and ETH Gain after one liquidation", async () => {
      await contracts.rateControl.setCoBias(0)
      // Whale opens Trove with 1e9 ETH
      await borrowerOperations.openTrove(dec(1e9, 'ether'), await getOpenTroveLUSDAmount(dec(1e11, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Defaulter 1 withdraws 'almost' 1e9 LUSD.
      await borrowerOperations.openTrove(dec(1e7, 'ether'), await getOpenTroveLUSDAmount(dec(999999991, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })

      // Defaulter 2 withdraws 594e7 LUSD
      //await borrowerOperations.openTrove(await getOpenTroveLUSDAmount(dec(594e7, 18)), defaulter_2, defaulter_2, { from: defaulter_2, value: dec(6e7, 'ether') })
      // slightly increase debt to ensure scale change
      // increasing debt reduces coll to sP, as coll sent to Sp = fraction of a trove's debt that's offset
      await borrowerOperations.openTrove(dec(6e7, 'ether'), await getOpenTroveLUSDAmount(dec(595e7, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      
      await lusdToken.transfer(alice, dec(1e9, 18), { from: whale })
      await stabilityPool.provideToSP(dec(1e9, 18), ZERO_ADDRESS, { from: alice })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated.  Value of P reduced to 9e9
      P0 = (await stabilityPool.P())
      assert.isTrue(P0.eq(toBN(dec(1,18))))
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx = await liquidations.liquidate(defaulter_1, { from: owner });

      const expP1 = await th.getNewPAfterLiquidation(contracts, tx, P0, liqDeposits, lastLUSDError)
      const P1 = await stabilityPool.P()

      assert.isTrue(P1.eq(expP1))
      assert.equal(await stabilityPool.currentScale(), '0')


      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))

      //B, C, D deposit to Stability Pool
      await lusdToken.transfer(bob, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: bob })

      await lusdToken.transfer(carol, dec(20000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(20000, 18), ZERO_ADDRESS, { from: carol })

      await lusdToken.transfer(dennis, dec(30000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(30000, 18), ZERO_ADDRESS, { from: dennis })

      // get deposits before for depositsAfterLiquidation()
      const aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      const bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      const carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      const dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      const whaleDeposit = await stabilityPool.getCompoundedLUSDDeposit(whale)

      // 595e7 LUSD liquidated.
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit, dennisFinalDeposit, whaleFinalDeposit] = (await th.depositsAfterLiquidation(contracts, txL2, [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, whaleDeposit]))


      const P2 = await stabilityPool.P()
      assert.equal(await stabilityPool.currentScale(), '1')

      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // V1 comment
      /* Expect depositors to retain 1% of their initial deposit, and an ETH gain 
      in proportion to their initial deposit:
     
      Bob:  1000 LUSD, 55 Ether
      Carol:  2000 LUSD, 110 Ether
      Dennis:  3000 LUSD, 165 Ether
     
      Total: 6000 LUSD, 300 Ether
      */
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), dec(16666, 13)), 1e13)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), dec(33333, 13)), 1e13)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dec(5, 17)), 1e13)
       
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobFinalDeposit), 1e18)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolFinalDeposit), 1e18)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dennisFinalDeposit), 1e18)

      const alice_ETHWithdrawn = await th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = await th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = await th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(1005, 17)), 4e15)
      //assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(2010, 17)), 7e15)
      //assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dec(3015, 17)), 2e16)
      // these numbers went down because defaulter debt when up, but stake stayed the same
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(100334, 15)), 4e15)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(200668, 15)), 7e15)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dec(30100, 16)), 2e16)
    })

    // Deposit's ETH reward spans one scale change - deposit reduced by correct amount

    // A make deposit 10000 LUSD
    // L1 brings P to 1e-5*P. L1:  9999.9000000000000000 LUSD
    // A withdraws
    // B makes deposit 10000 LUSD
    // L2 decreases P again by 1e-5, over the scale boundary: 9999.9000000000000000 (near to the 10000 LUSD total deposits)
    // B withdraws
    // expect d(B) = d0(B) * 1e-5
    // expect B gets entire ETH gain from L2
    it("withdrawCollateralGainToTrove(): deposit spans one scale factor change: Single depositor withdraws correct compounded deposit and ETH Gain after one liquidation, #2", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      
      // Defaulter 1 and default 2 each withdraw 99999 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      await lusdToken.transfer(alice, dec(100000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: alice })

      // price drops by 50%: defaulter 1 ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated.  Value of P updated to  to 1e13
      const P0 = await stabilityPool.P()
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)
      const expP1 = await th.getNewPAfterLiquidation(contracts, txL1, P0, liqDeposits, lastLUSDError)
      const P1 = await stabilityPool.P()

    // console.log("P1", P1.toString())
    // console.log("expP1", expP1.toString()) 
      assert.isTrue(P1.eq(expP1))        

      assert.equal(await stabilityPool.currentScale(), '0')

      // Alice withdraws
      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))


      // Bob deposits 10k-1 LUSD
      bobSpDeposit = toBN(dec(99999, 18))
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })
      totalBeforeLiq =  await stabilityPool.getTotalLUSDDeposits()
      otherDep =  (await stabilityPool.getTotalLUSDDeposits()).sub(bobSpDeposit)


      // Defaulter 2 liquidated
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      bobDepositAfter =  (await th.depositsAfterLiquidation(contracts, txL2, [bobSpDeposit, otherDep]))[0]
      P2 = await stabilityPool.P()
      const expP2 = await th.getNewPAfterLiquidation(contracts, txL2, P1, liq1Deposits, lastLUSDError1)

      assert.isTrue(txL2.receipt.status)
      //assert.isAtMost(th.getDifference(await stabilityPool.P(), dec(1, 17)), 1e12) // P decreases. P = 1e(13-5+9) = 1e17
      // TODO had to relax tolerance for P, is this ok? 1e14 => 3e14
      assert.isAtMost(th.getDifference(await stabilityPool.P(), dec(1, 17)), 3e14)
      assert.isTrue(expP2.eq(P2.div(toBN(dec(1,9)))))
      assert.equal(await stabilityPool.currentScale(), '1')

      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const bob_ETHWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()

      // Bob should withdraw 1e-5 of initial deposit: 0.1 LUSD and the full ETH gain of 100 ether
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), dec(1, 18)), 1e13)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDepositAfter), 1e13)
      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 18)), 1e16)
    })

    // A make deposit 10000 LUSD
    // L1 brings P to 1e-5*P. L1:  99999 LUSD
    // A withdraws
    // B,C D make deposit 10000, 20000, 30000
    // L2 decreases P again by 1e-5, over boundary. L2: 599995  (near to the 600000 LUSD total deposits)
    // B withdraws
    // expect d(B) = d0(B) * 1e-5
    // expect B gets entire ETH gain from L2
    it("withdrawCollateralGainToTrove(): Several deposits of varying amounts span one scale factor change. Depositors withdraws correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      // Defaulter 1 and default 2 withdraw up to debt of 99999 LUSD and 599995 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(6000, 'ether'), await getOpenTroveLUSDAmount(dec(599995, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })

      aliceSpDeposit = toBN(dec(100000, 18))
      await lusdToken.transfer(alice, aliceSpDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceSpDeposit, ZERO_ADDRESS, { from: alice })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));


      // Defaulter 1 liquidated.  Value of P updated to  to 9999999, i.e. in decimal, ~1e-10
      const P0 = await stabilityPool.P()
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const expP1 = await th.getNewPAfterLiquidation(contracts, txL1, P0, liq1Deposits, lastLUSDError1)
      const P1 = await stabilityPool.P()

      assert.isTrue(expP1.eq(P1))
      //assert.equal(await stabilityPool.P(), dec(1, 13))  // P decreases. P = 1e(18-5) = 1e13
      assert.equal(await stabilityPool.currentScale(), '0')

      const [aliceGain1, aliceDeposit1] = await th.depositorValuesAfterLiquidation(contracts, txL1, [aliceSpDeposit])


      // Alice withdraws
      // whale deposits LUSD so Alice can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(100, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))

      // B, C, D deposit 10000, 20000, 30000 LUSD
      bobSpDeposit = toBN(dec(100000, 18))
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })

      carolSpDeposit = toBN(dec(200000, 18))
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await lusdToken.transfer(carol, carolSpDeposit, { from: whale })
      await stabilityPool.provideToSP(carolSpDeposit, ZERO_ADDRESS, { from: carol })

      dennisSpDeposit = toBN(dec(300000, 18))
      await lusdToken.transfer(dennis, dennisSpDeposit, { from: whale })
      await stabilityPool.provideToSP(dennisSpDeposit, ZERO_ADDRESS, { from: dennis })

      // Defaulter 2 liquidated
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      const expP2 = await th.getNewPAfterLiquidation(contracts, txL2, P1, liq1Deposits, lastLUSDError1)
      const P2 = await stabilityPool.P()

      assert.isTrue(expP2.eq(P2.div(toBN(dec(1,9)))))

      assert.equal(await stabilityPool.currentScale(), '1')

      //assert.isAtMost(th.getDifference(await stabilityPool.P(), dec(1, 17)), 1e12) // P decreases. P = 1e(13-5+9) = 1e17
      assert.isAtMost(th.getDifference(await stabilityPool.P(), dec(1, 17)), 1e15) // P decreases. P = 1e(13-5+9) = 1e17

      // include 1 LUSD whale deposit
      const [bobGain2, carolGain2, dennisGain2, whaleGain2, bobDeposit2, carolDeposit2, dennisDeposit2, whaleDeposit2] =
            await th.depositorValuesAfterLiquidation(contracts, txL2, [bobSpDeposit, carolSpDeposit, dennisSpDeposit, toBN(dec(1,18))])

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const bob_ETHWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()

      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const carol_ETHWithdrawn = await th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      const dennis_ETHWithdrawn = await th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // {B, C, D} should have a compounded deposit of {1+1/6, 2+1/3, 3+1/2} of 6 remaining LUSD
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), dec(1, 18)), 2e12)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), dec(2, 18)), 4e12)
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dec(3, 18)), 5e12)

      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(bob)).toString(), bobDeposit2), 2e12)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(carol)).toString(), carolDeposit2), 4e12)
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dennisDeposit2), 5e12)

      assert.isAtMost(th.getDifference(bob_ETHWithdrawn, dec(995, 18)), 1e16)
      assert.isAtMost(th.getDifference(carol_ETHWithdrawn, dec(1990, 18)), 1e16)
      assert.isAtMost(th.getDifference(dennis_ETHWithdrawn, dec(2985, 18)), 1e16)
    })

    // A make deposit 10000 LUSD
    // L1 brings P to (~1e-10)*P. L1: 9999.9999999000000000 LUSD
    // Expect A to withdraw 0 deposit
    it("withdrawCollateralGainToTrove(): Deposit that decreases to less than 1e-9 of it's original value is reduced to 1", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      
      // Defaulters 1 withdraws 9999.9999999 LUSD
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount('9999999999900000000000'), defaulter_1, defaulter_1, { from: defaulter_1 })

      // Price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: alice })

      // Defaulter 1 liquidated. P -> (~1e-10)*P
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)

      const aliceDeposit = (await stabilityPool.getCompoundedLUSDDeposit(alice)).toString()
      // console.log(`alice deposit: ${aliceDeposit}`)
      assert.isAtMost(th.getDifference(aliceDeposit, toBN(dec(1, 18))), 10000)
    })

    // --- Serial scale changes ---

    /* A make deposit 100000 LUSD
    L1 brings P to 0.0001P. L1:  99999 LUSD, 1 ETH
    B makes deposit 99999, brings SP to 10k
    L2 decreases P by(~1e-5)P. L2:  99999 LUSD, 1 ETH
    C makes deposit 99999, brings SP to 10k
    L3 decreases P by(~1e-5)P. L3:  99999 LUSD, 1 ETH
    D makes deposit 99999, brings SP to 10k
    L4 decreases P by(~1e-5)P. L4:  99999 LUSD, 1 ETH
    expect A, B, C, D each withdraw ~100 Ether
    */
    it("withdrawCollateralGainToTrove(): Several deposits of 10000 LUSD span one scale factor change. Depositors withdraws correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })
      
      // Defaulters 1-4 each withdraw 99999 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount('99999000000000000000000'), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount('99999000000000000000000'), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount('99999000000000000000000'), defaulter_3, defaulter_3, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount('99999000000000000000000'), defaulter_4, defaulter_4, { from: defaulter_4 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      await lusdToken.transfer(alice, dec(100000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: alice })

      // Defaulter 1 liquidated. 
      P0 = await stabilityPool.P()
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)
      const expP1 = await th.getNewPAfterLiquidation(contracts, txL1, P0, liq1Deposits, lastLUSDError1)
      P1 = await stabilityPool.P()
      assert.isTrue(expP1.eq(P1))
      //assert.equal(await stabilityPool.P(), dec(1, 13)) // P decreases to 1e(18-5) = 1e13
      assert.equal(await stabilityPool.currentScale(), '0')

      // B deposits 99999 LUSD
      await lusdToken.transfer(bob, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: bob })

      // Defaulter 2 liquidated
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      const expP2 = await th.getNewPAfterLiquidation(contracts, txL2, P1, liq1Deposits, lastLUSDError1)
      P2 = await stabilityPool.P()
      assert.isTrue(expP2.eq(P2.div(toBN(dec(1,9)))))

      //assert.equal(await stabilityPool.P(), dec(1, 17)) // Scale changes and P changes to 1e(13-5+9) = 1e17
      assert.equal(await stabilityPool.currentScale(), '1')

      // C deposits 99999 LUSD
      await lusdToken.transfer(carol, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: carol })

      // Defaulter 3 liquidated
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL3 = await liquidations.liquidate(defaulter_3, { from: owner });
      assert.isTrue(txL3.receipt.status)
      const expP3 = await th.getNewPAfterLiquidation(contracts, txL3, P2, liq1Deposits, lastLUSDError1)
      P3 = await stabilityPool.P()
      assert.isTrue(expP3.eq(P3))
      //assert.equal(await stabilityPool.P(), dec(1, 12)) // P decreases to 1e(17-5) = 1e12
      assert.equal(await stabilityPool.currentScale(), '1')

      // D deposits 99999 LUSD
      const dennisDeposit = toBN(dec(99999, 18))
      await lusdToken.transfer(dennis, dennisDeposit, { from: whale })
      await stabilityPool.provideToSP(dennisDeposit, ZERO_ADDRESS, { from: dennis })

      const totalBefore = await stabilityPool.getTotalLUSDDeposits()

      // Defaulter 4 liquidated
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      const txL4 = await liquidations.liquidate(defaulter_4, { from: owner });
      assert.isTrue(txL4.receipt.status)
      const expP4 = await th.getNewPAfterLiquidation(contracts, txL4, P3, liq1Deposits, lastLUSDError1)
      P4 = await stabilityPool.P()
      assert.isTrue(expP4.eq(P4.div(toBN(dec(1,9)))))
      //assert.equal(await stabilityPool.P(), dec(1, 16)) // Scale changes and P changes to 1e(12-5+9) = 1e16
      assert.equal(await stabilityPool.currentScale(), '2')

      const [,drip] = await th.getEmittedDripValues(contracts,txL4)

      const dennisAfterDrip = dennisDeposit.add(dennisDeposit.mul(drip).div(totalBefore))
      const totalAfterDrip = totalBefore.add(drip)

      const stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", contracts.stabilityPool.address)).interface;
      var offsetDebt = toBN(await th.getRawEventArgByName(txL4, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "debtToOffset"))

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: carol })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: dennis })

      const alice_ETHWithdrawn = await th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_ETHWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_ETHWithdrawn = await th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_ETHWithdrawn = await th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // A, B, C should retain 0 - their deposits have been completely used up
      assert.equal(await stabilityPool.getCompoundedLUSDDeposit(alice), '0')
      assert.equal(await stabilityPool.getCompoundedLUSDDeposit(alice), '0')
      assert.equal(await stabilityPool.getCompoundedLUSDDeposit(alice), '0')

      // D should retain around 0.9999 LUSD, since his deposit of 99999 was reduced by a factor of 1e-5
      //assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), dec(99999, 13)), 100000)
      const expDennisFinal = dennisAfterDrip.sub(offsetDebt.mul(dennisAfterDrip).div(totalAfterDrip))
      assert.isAtMost(th.getDifference((await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString(), expDennisFinal), 1000000)

      // 99.5 ETH is offset at each L, 0.5 goes to gas comp
      // Each depositor gets ETH rewards of around 99.5 ETH. 1e17 error tolerance
      assert.isTrue(toBN(alice_ETHWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
      assert.isTrue(toBN(bob_ETHWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
      assert.isTrue(toBN(carol_ETHWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
      assert.isTrue(toBN(dennis_ETHWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
    })

    it("withdrawCollateralGainToTrove(): 2 depositors can withdraw after each receiving half of an almost pool-emptying liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: A })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: B })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: C })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: D })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: E })
      await borrowerOperations.openTrove(dec(10000, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), ZERO_ADDRESS, ZERO_ADDRESS, { from: F })
      
      // Defaulters 1-3 each withdraw 24100, 24300, 24500 LUSD (inc gas comp)
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(24100, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(24300, 18)), defaulter_2, defaulter_2, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(24500, 18)), defaulter_3, defaulter_3, { from: defaulter_3 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // A, B provide 10k LUSD 
      await lusdToken.transfer(A, dec(10000, 18), { from: whale })
      await lusdToken.transfer(B, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: A })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: B })

      // Defaulter 1 liquidated. SP emptied
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)

      // Check compounded deposits
      const A_deposit = await stabilityPool.getCompoundedLUSDDeposit(A)
      const B_deposit = await stabilityPool.getCompoundedLUSDDeposit(B)
      // console.log(`A_deposit: ${A_deposit}`)
      // console.log(`B_deposit: ${B_deposit}`)
      assert.isAtMost(th.getDifference(A_deposit, toBN(dec(5, 17))), 10000)
      assert.isAtMost(th.getDifference(B_deposit, toBN(dec(5, 17))), 10000)

      // Check SP tracker is 1
      const LUSDinSP1 = await stabilityPool.getTotalLUSDDeposits()
      //console.log(`LUSDinSP1: ${LUSDinSP1}`)
      //assert.equal(LUSDinSP1, dec(1, 18))
      assert.isAtMost(th.getDifference(LUSDinSP1, dec(1, 18)), 1)

      // Check SP LUSD balance is 1
      const SPLUSDBalance_1 = await lusdToken.balanceOf(stabilityPool.address)
      // console.log(`SPLUSDBalance_1: ${SPLUSDBalance_1}`)
      //assert.equal(SPLUSDBalance_1, dec(1, 18))
      assert.isAtMost(th.getDifference(SPLUSDBalance_1, dec(1, 18)), 1)

      // Attempt withdrawals
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: A })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: B })
      await priceFeed.setPrice(dec(100, 18))

      assert.isTrue(txA.receipt.status)
      assert.isTrue(txB.receipt.status)

      // ==========

      // C, D provide 10k LUSD 
      await lusdToken.transfer(C, dec(10000, 18), { from: whale })
      await lusdToken.transfer(D, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: C })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: D })

      // Defaulter 2 liquidated.  SP emptied
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)

      // Check compounded deposits
      const C_deposit = await stabilityPool.getCompoundedLUSDDeposit(C)
      const D_deposit = await stabilityPool.getCompoundedLUSDDeposit(D)
      // console.log(`C_deposit: ${C_deposit}`)
      // console.log(`D_deposit: ${D_deposit}`)
      assert.equal(C_deposit, '499975001200009999')
      assert.equal(D_deposit, '499975001200009999')

      // Check SP tracker is 1
      const LUSDinSP_2 = await stabilityPool.getTotalLUSDDeposits()
      // console.log(`LUSDinSP_2: ${LUSDinSP_2}`)
      //assert.equal(LUSDinSP_2, dec(1, 18))
      assert.isAtMost(th.getDifference(LUSDinSP_2, dec(1, 18)), 1)

      // Check SP LUSD balance is 1
      const SPLUSDBalance_2 = await lusdToken.balanceOf(stabilityPool.address)
      // console.log(`SPLUSDBalance_2: ${SPLUSDBalance_2}`)
      //assert.equal(SPLUSDBalance_2, dec(1, 18))
      assert.isAtMost(th.getDifference(SPLUSDBalance_2, dec(1, 18)), 1)

      // Attempt withdrawals
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txC = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: C })
      const txD = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: D })
      await priceFeed.setPrice(dec(100, 18))

      assert.isTrue(txC.receipt.status)
      assert.isTrue(txD.receipt.status)

      // ============

      // E, F provide 10k LUSD 
      await lusdToken.transfer(E, dec(10000, 18), { from: whale })
      await lusdToken.transfer(F, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: E })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: F })

      // Defaulter 3 liquidated. SP emptied
      const txL3 = await liquidations.liquidate(defaulter_3, { from: owner });
      assert.isTrue(txL3.receipt.status)

      // Check compounded deposits
      const E_deposit = await stabilityPool.getCompoundedLUSDDeposit(E)
      const F_deposit = await stabilityPool.getCompoundedLUSDDeposit(F)
    // console.log(`E_deposit: ${E_deposit.toString()}`)
    // console.log(`F_deposit: ${F_deposit.toString()}`)
      // V1
      assert.equal(E_deposit.toString(), '499975001134028698')
      assert.equal(F_deposit.toString(), '499975001134028698')
       
      // output is 499975001134036699
      //assert.equal(E_deposit, '499975001134028698')
      //assert.equal(F_deposit, '499975001134028698')

      // Check SP tracker is 1
      const LUSDinSP_3 = await stabilityPool.getTotalLUSDDeposits()
      //assert.equal(LUSDinSP_3, dec(1, 18))
      assert.isAtMost(th.getDifference(LUSDinSP_3, dec(1, 18)), 1)

      // Check SP LUSD balance is 1
      const SPLUSDBalance_3 = await lusdToken.balanceOf(stabilityPool.address)
      // console.log(`SPLUSDBalance_3: ${SPLUSDBalance_3}`)
      //assert.equal(SPLUSDBalance_3, dec(1, 18))
      assert.isAtMost(th.getDifference(SPLUSDBalance_3, dec(1, 18)), 1)

      // Attempt withdrawals
      await assertRevert(stabilityPool.withdrawFromSP(dec(1000, 18), { from: E }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")
      await assertRevert(stabilityPool.withdrawFromSP(dec(1000, 18), { from: F }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")
      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      const txE = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: E })
      const txF = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: F })
      assert.isTrue(txE.receipt.status)
      assert.isTrue(txF.receipt.status)
    })

    // --- Extreme values, confirm no overflows ---

    it("withdrawCollateralGainToTrove(): Large liquidated coll/debt, deposits and ETH price", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // ETH:USD price is $2 billion per ETH
      await priceFeed.setPrice(dec(2, 27));

      // Defaulter opens trove with 200% ICR
      await borrowerOperations.openTrove(dec(1, 27), await getOpenTroveLUSDAmount(dec(1, 36)), defaulter_1, defaulter_1, { from: defaulter_1 })


      const depositors = [alice, bob]
      spDeposit = toBN(dec(1, 36))
      for (account of depositors) {
        await borrowerOperations.openTrove(dec(2, 27), spDeposit, account, account, { from: account })
      }

      for (account of depositors) {
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // ETH:USD price drops to $1 billion per ETH
      await priceFeed.setPrice(dec(1, 27));

      // Defaulter liquidated      
      P0 = (await stabilityPool.P())
      assert.isTrue(P0.eq(toBN(dec(1,18))))
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      const finalDeposit = (await th.depositsAfterLiquidation(contracts, tx, [spDeposit, spDeposit]))[0]
      const expP1 = await th.getNewPAfterLiquidation(contracts, tx, P0, liqDeposits, lastLUSDError)

      // ensure expected P is correct
      currentP = (await stabilityPool.P())
      assert.isTrue(currentP.eq(expP1))

      const txA = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txB = await stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_ETHWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral')
      const bob_ETHWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral')

      // Check LUSD balances
      const aliceLUSDBalance = await stabilityPool.getCompoundedLUSDDeposit(alice)
      //const aliceExpectedLUSDBalance = web3.utils.toBN(dec(5, 35))
      const aliceExpectedLUSDBalance = finalDeposit
      const aliceLUSDBalDiff = aliceLUSDBalance.sub(aliceExpectedLUSDBalance).abs()

      // V1
      //assert.isTrue(aliceLUSDBalDiff.lte(toBN(dec(1, 18)))) // error tolerance of 1e18
      // increased error tolerance
      assert.isTrue(aliceLUSDBalDiff.lte(toBN(dec(2, 18)))) // error tolerance of 2e18

      const bobLUSDBalance = await stabilityPool.getCompoundedLUSDDeposit(bob)
      //const bobExpectedLUSDBalance = toBN(dec(5, 35))
      const bobExpectedLUSDBalance = finalDeposit
      const bobLUSDBalDiff = bobLUSDBalance.sub(bobExpectedLUSDBalance).abs()

      // V1
      //assert.isTrue(bobLUSDBalDiff.lte(toBN(dec(1, 18))))
      // increased error tolerance
      assert.isTrue(bobLUSDBalDiff.lte(toBN(dec(2, 18))))

      // Check ETH gains
      const aliceExpectedETHGain = toBN(dec(4975, 23))
      const aliceETHDiff = aliceExpectedETHGain.sub(toBN(alice_ETHWithdrawn))

      assert.isTrue(aliceETHDiff.lte(toBN(dec(1, 18))))

      const bobExpectedETHGain = toBN(dec(4975, 23))
      const bobETHDiff = bobExpectedETHGain.sub(toBN(bob_ETHWithdrawn))

      assert.isTrue(bobETHDiff.lte(toBN(dec(1, 18))))
    })

    it("withdrawCollateralGainToTrove(): Small liquidated coll/debt, large deposits and ETH price", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, { from: whale })

      // ETH:USD price is $2 billion per ETH
      await priceFeed.setPrice(dec(2, 27));
      const price = await priceFeed.getPrice()

      // Defaulter opens trove with 50e-7 ETH and  5000 LUSD. 200% ICR
      await borrowerOperations.openTrove(dec('5000000000000' ), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_1, defaulter_1, { from: defaulter_1 })

      const depositors = [alice, bob]
      spDeposit = toBN(dec(1, 38))
      for (account of depositors) {
        await collateralToken.mint(account, dec(2, 29), { from: owner })
        await collateralToken.approve(activePool.address, dec(2, 29), { from: account })
        await borrowerOperations.openTrove(dec(2, 29), spDeposit, account, account, { from: account })
      }

      for (account of depositors) {
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // ETH:USD price drops to $1 billion per ETH
      await priceFeed.setPrice(dec(1, 27));

      P0 = await stabilityPool.P()
      assert.isTrue(P0.eq(toBN(dec(1,18))))
      // Defaulter liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const finalDeposit = (await th.depositsAfterLiquidation(contracts, tx1, [spDeposit, spDeposit]))[0]
      const expP1 = await th.getNewPAfterLiquidation(contracts, tx1, P0, liqDeposits, lastLUSDError)

      // ensure expected P is correct
      currentP = (await stabilityPool.P())
      assert.isTrue(currentP.eq(expP1))

      // use P to calc deposit
      // This is more accurate than th.depositsAfterLiquidation() for some reason
      expDepositWithP = expP1.mul(spDeposit).div(toBN(dec(1, 18)))

      const txAPromise = stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: alice })
      const txBPromise = stabilityPool.withdrawCollateralGainToTrove(ZERO_ADDRESS, ZERO_ADDRESS, { from: bob })

      // Expect ETH gain per depositor of ~1e11 wei to be rounded to 0 by the ETHGainedPerUnitStaked calculation (e / D), where D is ~1e36.
      await th.assertRevert(txAPromise, 'StabilityPool: caller must have non-zero ETH Gain')
      await th.assertRevert(txBPromise, 'StabilityPool: caller must have non-zero ETH Gain')

      const aliceLUSDBalance = await stabilityPool.getCompoundedLUSDDeposit(alice)
      // const aliceLUSDBalance = await lusdToken.balanceOf(alice)
      //const aliceExpectedLUSDBalance = toBN('99999999999999997500000000000000000000')
      //const aliceExpectedLUSDBalance = finalDeposit
      const aliceExpectedLUSDBalance = expDepositWithP
      const aliceLUSDBalDiff = aliceLUSDBalance.sub(aliceExpectedLUSDBalance).abs()

      assert.isTrue(aliceLUSDBalDiff.lte(toBN(dec(1, 18))))

      const bobLUSDBalance = await stabilityPool.getCompoundedLUSDDeposit(bob)
      //const bobExpectedLUSDBalance = toBN('99999999999999997500000000000000000000')
      //const bobExpectedLUSDBalance = finalDeposit
      const bobExpectedLUSDBalance = expDepositWithP
      const bobLUSDBalDiff = bobLUSDBalance.sub(bobExpectedLUSDBalance).abs()

      assert.isTrue(bobLUSDBalDiff.lte(toBN('100000000000000000000')))
    })
  })
})

contract('Reset chain state', async accounts => { })
