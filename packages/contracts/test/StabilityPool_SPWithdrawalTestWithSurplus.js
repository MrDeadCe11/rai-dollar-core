const deploymentHelper = require("../utils/deploymentHelpers.js")
const testHelpers = require("../utils/testHelpers.js")
const LiquidationsTester = artifacts.require("./LiquidationsTester.sol")
const TroveManagerTester = artifacts.require("./TroveManagerTester.sol")
const RateControlTester = artifacts.require("./RateControlTester.sol")
const TroveManagerLib = artifacts.require("./Dependencies/TroveManagerLib.sol")
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

  let gasPriceInWei

  const ZERO_ADDRESS = th.ZERO_ADDRESS

  const getOpenTroveLUSDAmount = async (totalDebt) => th.getOpenTroveLUSDAmount(contracts, totalDebt)
  const assertRevert = th.assertRevert

  describe("Stability Pool Withdrawal", async () => {
    let lib;
    before(async () => {
      gasPriceInWei = await web3.eth.getGasPrice()
      lib = await TroveManagerLib.new();
      await TroveManagerTester.link(lib);
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
      rateControl = contracts.rateControl
      activePool = contracts.activePool
      stabilityPool = contracts.stabilityPool
      defaultPool = contracts.defaultPool
      borrowerOperations = contracts.borrowerOperations
      collateralToken = contracts.collateralToken

      await deploymentHelper.connectLQTYContracts(LQTYContracts)
      await deploymentHelper.connectCoreContracts(contracts, LQTYContracts)
      await deploymentHelper.connectLQTYContractsToCore(LQTYContracts, contracts)

      tx = await th.batchMintCollateralTokensAndApproveActivePool(contracts, [owner, defaulter_1, defaulter_2, defaulter_3, defaulter_4, defaulter_5, defaulter_6, whale, alice, bob, carol, dennis, erin, flyn, graham, harriet, A, B, C, D, E, F ], toBN(dec(1000, 26)))
      // should trigger surplus for most tests
      // just adding these here(even with existing values) accrues more interest when drip() is called 
      // in each test so some tolerances are slightly loosened in these tests
      await liquidations.setLiqPenalty(dec(101, 16))
      await liquidations.setLiqPenaltyRedist(dec(102,16))
    })

    // --- Compounding tests ---

    // --- withdrawFromSP()

    // --- Identical deposits, identical liquidation amounts---
    it("withdrawFromSP(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulter opens trove with 200% ICR and 10k LUSD net debt
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      aliceStartingDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobStartingDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolStartingDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      totalStartingDeposits = aliceStartingDeposit.add(bobStartingDeposit).add(carolStartingDeposit)

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      var [aliceDeposit, bobDeposit, carolDeposit] = await th.depositsAfterLiquidation(contracts, tx, [aliceStartingDeposit, bobStartingDeposit, carolStartingDeposit])

      const expP_1 = await th.getNewPAfterLiquidation(contracts, tx, toBN(dec(1, 18)), liqDeposits, lastLUSDError)

      totalDeposits = await stabilityPool.getTotalLUSDDeposits()

      // whale deposits LUSD so all can exit
      tx = await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      const [,drip] = await th.getEmittedDripValues(contracts, tx)
      aliceDrip = drip.mul(aliceDeposit).div(totalDeposits)
      bobDrip = drip.mul(bobDeposit).div(totalDeposits)
      carolDrip = drip.mul(carolDeposit).div(totalDeposits)

      aliceDeposit = aliceDeposit.add(aliceDrip)
      bobDeposit = bobDeposit.add(bobDrip)
      carolDeposit = carolDeposit.add(carolDrip)

      totalDeposits = totalDeposits.add(drip).add(toBN(dec(1,18)))

      // Check depositors' compounded deposit is 6666.66 LUSD and ETH Gain is 33.16 ETH
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const [,dripA] = await th.getEmittedDripValues(contracts, txA)
      aliceDrip = dripA.mul(aliceDeposit).div(totalDeposits)
      bobDrip = dripA.mul(bobDeposit).div(totalDeposits)
      carolDrip = dripA.mul(carolDeposit).div(totalDeposits)

      aliceDeposit = aliceDeposit.add(aliceDrip)
      bobDeposit = bobDeposit.add(bobDrip)
      carolDeposit = carolDeposit.add(carolDrip)

      totalDeposits = totalDeposits.add(dripA).sub(aliceDeposit)

      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const [,dripB] = await th.getEmittedDripValues(contracts, txB)

      bobDrip = dripB.mul(bobDeposit).div(totalDeposits)
      carolDrip = dripB.mul(carolDeposit).div(totalDeposits)

      bobDeposit = bobDeposit.add(bobDrip)
      carolDeposit = carolDeposit.add(carolDrip)

      totalDeposits = totalDeposits.add(dripB).sub(bobDeposit)

      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      const [,dripC] = await th.getEmittedDripValues(contracts, txC)

      carolDrip = dripC.mul(carolDeposit).div(totalDeposits)

      carolDeposit = carolDeposit.add(carolDrip)

      totalDeposits = totalDeposits.add(dripC).sub(carolDeposit)

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '6666666666666666666666'), 10000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit), 31000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDeposit), 28000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolDeposit), 30000)

      aliceExpColl = toBN(dec(995,17)).mul(aliceStartingDeposit).div(totalStartingDeposits)
      bobExpColl = toBN(dec(995,17)).mul(bobStartingDeposit).div(totalStartingDeposits)
      carolExpColl = toBN(dec(995,17)).mul(carolStartingDeposit).div(totalStartingDeposits)
      console.log("aliceExpColl " + aliceExpColl)

      //assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '33166666666666666667'), 10000)
      //assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '33166666666666666667'), 10000)
      //assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '33166666666666666667'), 10000)
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, aliceExpColl), 10000)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, bobExpColl), 10000)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, carolExpColl), 10000)
    })

    it("withdrawFromSP(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after two identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      aliceStartingDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobStartingDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolStartingDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)

      totalDeposits = aliceStartingDeposit.add(bobStartingDeposit).add(carolStartingDeposit)

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      var [aliceDeposit, bobDeposit, carolDeposit] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [aliceStartingDeposit, bobStartingDeposit, carolStartingDeposit]))


      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: whale })

      // Check depositors' compounded deposit is 3333.33 LUSD and ETH Gain is 66.33 ETH
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '3333333333333333333333'), 10000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '3333333333333333333333'), 10000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '3333333333333333333333'), 10000)
        //
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit), 3e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDeposit), 4e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolDeposit), 4e13)

      aliceColl = toBN(dec(199,18)).mul(aliceStartingDeposit).div(totalDeposits)
      bobColl = toBN(dec(199,18)).mul(bobStartingDeposit).div(totalDeposits)
      carolColl = toBN(dec(199,18)).mul(carolStartingDeposit).div(totalDeposits)
       
      //assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '66333333333333333333'), 10000)
      //assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '66333333333333333333'), 10000)
      //assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '66333333333333333333'), 10000)
      
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, aliceColl), 10000)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, bobColl), 10000)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, carolColl), 10000)
    })

    it("withdrawFromSP():  Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after three identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      await liquidations.liquidate(defaulter_1, { from: owner });
      await liquidations.liquidate(defaulter_2, { from: owner });
      tx = await liquidations.liquidate(defaulter_3, { from: owner });
      const [,drip] = await th.getEmittedDripValues(contracts,tx)
      const [liquidatedDebt] = await th.getEmittedLiquidationValues(tx)

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Check depositors' compounded deposit is 0 LUSD and ETH Gain is 99.5 ETH 
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      // 1/3 LUSD each
      // TODO: tight tolerances by considering drips
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '333333333333330000'), 4e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '333333333333330000'), 6e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '333333333333330000'), 8e13)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(99500, 15)), 5e15)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(99500, 15)), 5e15)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(99500, 15)), 5e15)
    })

    // --- Identical deposits, increasing liquidation amounts ---
    it("withdrawFromSP(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after two liquidations of increasing LUSD", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(toBN('50000000000000000000'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(toBN('70000000000000000000'), await getOpenTroveLUSDAmount(dec(7000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

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
      const finalDeposit = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))[0]


      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: whale })

      // Check depositors' compounded deposit
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '6000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '6000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '6000000000000000000000'), 10000)

      // TODO: tighten tolerances by considering drips
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), finalDeposit), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), finalDeposit), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), finalDeposit), 1e15)

      // (0.5 + 0.7) * 99.5 / 3
      // TODO: tighten tolerances by considering drips
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(398, 17)), 1e13)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(398, 17)), 1e13)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(398, 17)), 1e13)
    })

    it("withdrawFromSP(): Depositors with equal initial deposit withdraw correct compounded deposit and ETH Gain after three liquidations of increasing LUSD", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove( dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(toBN('50000000000000000000'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1})
      await borrowerOperations.openTrove(toBN('60000000000000000000'), await getOpenTroveLUSDAmount(dec(6000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2})
      await borrowerOperations.openTrove(toBN('70000000000000000000'), await getOpenTroveLUSDAmount(dec(7000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3})


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
      const finalDeposit = (await th.depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, [spDeposit, spDeposit, spDeposit]))[0]

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Check depositors' compounded deposit
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '4000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '4000000000000000000000'), 10000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '4000000000000000000000'), 10000)
      
      // TODO: tighten tolerances with drip calcuations
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), finalDeposit), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), finalDeposit), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), finalDeposit), 3e15)

      // (0.5 + 0.6 + 0.7) * 99.5 / 3
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(597, 17)), 1e14)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(597, 17)), 1e14)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(597, 17)), 1e14)
    })

    // --- Increasing deposits, identical liquidation amounts ---
    it("withdrawFromSP(): Depositors with varying deposits withdraw correct compounded deposit and ETH Gain after two identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      // 2 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      // Whale transfers 10k, 20k, 30k LUSD to A, B and C respectively who then deposit it to the SP
      aliceDeposit = toBN(dec(10000, 18))
      await lusdToken.transfer(alice, aliceDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice })

      bobDeposit = toBN(dec(20000, 18))
      await lusdToken.transfer(bob, bobDeposit, { from: whale })
      await stabilityPool.provideToSP(bobDeposit, ZERO_ADDRESS, { from: bob })

      carolDeposit = toBN(dec(30000, 18))
      await lusdToken.transfer(carol, carolDeposit, { from: whale })
      await stabilityPool.provideToSP(carolDeposit, ZERO_ADDRESS, { from: carol })


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [aliceDeposit, bobDeposit, carolDeposit]))
      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Depositors attempt to withdraw everything
      const txA = await stabilityPool.withdrawFromSP(aliceDeposit, { from: alice })
      const txB = await stabilityPool.withdrawFromSP(bobDeposit, { from: bob })
      const txC = await stabilityPool.withdrawFromSP(carolDeposit, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '6666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '13333333333333333333333'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '20000000000000000000000'), 100000)
       
      // TODO: tighten tolerances by calculating drips 
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceFinalDeposit), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobFinalDeposit), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolFinalDeposit), 3e15)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '33166666666666666667'), 1e13)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '66333333333333333333'), 1e13)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(995, 17)), 1e13)
    })

    it("withdrawFromSP(): Depositors with varying deposits withdraw correct compounded deposit and ETH Gain after three identical liquidations", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })

      // Whale transfers 10k, 20k, 30k LUSD to A, B and C respectively who then deposit it to the SP
      aliceDeposit = toBN(dec(10000, 18))
      await lusdToken.transfer(alice, aliceDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice })

      bobDeposit = toBN(dec(20000, 18))
      await lusdToken.transfer(bob, bobDeposit, { from: whale })
      await stabilityPool.provideToSP(bobDeposit, ZERO_ADDRESS, { from: bob })

      carolDeposit = toBN(dec(30000, 18))
      await lusdToken.transfer(carol, carolDeposit, { from: whale })
      await stabilityPool.provideToSP(carolDeposit, ZERO_ADDRESS, { from: carol })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Three defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = (await th.depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, [aliceDeposit, bobDeposit, carolDeposit]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Depositors attempt to withdraw everything
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(20000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(30000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '5000000000000000000000'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '10000000000000000000000'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '15000000000000000000000'), 100000)
      // TODO: tighten tolerances by considering drips
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceFinalDeposit), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobFinalDeposit), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolFinalDeposit), 2e15)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '49750000000000000000'), 2e13)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 17)), 2e13)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '149250000000000000000'), 2e13)
    })

    // --- Varied deposits and varied liquidation amount ---
    it("withdrawFromSP(): Depositors with varying deposits withdraw correct compounded deposit and ETH Gain after three varying liquidations", async () => {
      // Whale opens Trove with 1m ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      /* Defaulters open troves
     
      Defaulter 1: 207000 LUSD & 2160 ETH
      Defaulter 2: 5000 LUSD & 50 ETH
      Defaulter 3: 46700 LUSD & 500 ETH
      */
      await borrowerOperations.openTrove(dec(2160, 18), await getOpenTroveLUSDAmount('207000000000000000000000'), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(50, 'ether'), await getOpenTroveLUSDAmount(dec(5, 21)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      // add more debt to this trove so liquidation takes full collateral
      //await borrowerOperations.openTrove(await getOpenTroveLUSDAmount('46700000000000000000000'), defaulter_3, defaulter_3, false, { from: defaulter_3, value: dec(500, 'ether') })
      await borrowerOperations.openTrove(dec(500, 'ether'), await getOpenTroveLUSDAmount('48700000000000000000000'), defaulter_3, defaulter_3, false, { from: defaulter_3 })

      /* Depositors provide:-
      Alice:  2000 LUSD
      Bob:  456000 LUSD
      Carol: 13100 LUSD */
      // Whale transfers LUSD to  A, B and C respectively who then deposit it to the SP
      aliceDeposit = toBN(dec(2000, 18))
      await lusdToken.transfer(alice, aliceDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice })
      bobDeposit = toBN(dec(456000, 18))
      await lusdToken.transfer(bob, bobDeposit, { from: whale })
      await stabilityPool.provideToSP(bobDeposit, ZERO_ADDRESS, { from: bob })
      carolDeposit = toBN(dec(13100, 18))
      await lusdToken.transfer(carol, carolDeposit, { from: whale })
      await stabilityPool.provideToSP(carolDeposit, ZERO_ADDRESS, { from: carol })

      // price drops by 50%: defaulter ICR falls to 100%
      price = dec(100, 18)
      await priceFeed.setPrice(price);

      defaulter_1_ICR = await contracts.troveManager.getCurrentICR(defaulter_1, price)
      defaulter_2_ICR = await contracts.troveManager.getCurrentICR(defaulter_2, price)
      defaulter_3_ICR = await contracts.troveManager.getCurrentICR(defaulter_3, price)

      // Three defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });

      const [liquidatedDebt1, liquidatedColl1, collGasComp1, lusdGasComp1] = th.getEmittedLiquidationValues(tx1)
      const [liquidatedDebt2, liquidatedColl2, collGasComp2, lusdGasComp2] = th.getEmittedLiquidationValues(tx2)
      const [liquidatedDebt3, liquidatedColl3, collGasComp3, lusdGasComp3] = th.getEmittedLiquidationValues(tx3)

      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit] = (await th.depositsAfterThreeLiquidations(contracts, tx1, tx2, tx3, [aliceDeposit, bobDeposit, carolDeposit]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Depositors attempt to withdraw everything
      const txA = await stabilityPool.withdrawFromSP(dec(500000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(500000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(500000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      // TODO: tighten tolerances by considering drips
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceFinalDeposit), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobFinalDeposit), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolFinalDeposit), 3e15)

      totalLiqCollateral = liquidatedColl1.add(liquidatedColl2).add(liquidatedColl3)
      totalDeposits = aliceDeposit.add(bobDeposit).add(carolDeposit)

      // withdrawn = totalLiqCollateral * {2000, 456000, 13100}/4711
      expAlice_CollateralWithdrawn = totalLiqCollateral.mul(aliceDeposit).div(totalDeposits)
      expBob_CollateralWithdrawn = totalLiqCollateral.mul(bobDeposit).div(totalDeposits)
      expCarol_CollateralWithdrawn = totalLiqCollateral.mul(carolDeposit).div(totalDeposits)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, expAlice_CollateralWithdrawn), 3e13)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, expBob_CollateralWithdrawn), 3e13)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, expCarol_CollateralWithdrawn), 3e13)

    })

    // --- Deposit enters at t > 0

    it("withdrawFromSP(): A, B, C Deposit -> 2 liquidations -> D deposits -> 1 liquidation. All deposits and liquidations = 100 LUSD.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })

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
      const [aliceGain1, bobGain1, carolGain1, aliceDeposit1, bobDeposit1, carolDeposit1] = (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))

      // Whale transfers 10k to Dennis who then provides to SP
      await lusdToken.transfer(dennis, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: dennis })

      // Third defaulter liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceGain2, bobGain2, carolGain2, dennisGain2, aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] = (await th.depositorValuesAfterLiquidation(contracts, tx3, [aliceDeposit1, bobDeposit1, carolDeposit1, spDeposit]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '1666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '1666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '1666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '5000000000000000000000'), 100000)
       
      // TODO: tighten
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit2), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDeposit2), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolDeposit2), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisDeposit2), 2e15)

      //assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '82916666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '82916666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '82916666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, '49750000000000000000'), 100000)

      // TODO: tighten
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, aliceGain1.add(aliceGain2)), 1e14)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, bobGain1.add(bobGain2)), 1e14)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, carolGain1.add(carolGain2)), 1e14)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dennisGain2), 1e14)
    })

    it("withdrawFromSP(): A, B, C Deposit -> 2 liquidations -> D deposits -> 2 liquidations. All deposits and liquidations = 100 LUSD.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
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

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated, 2/3 of SP, 10000/3 left
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceDeposit1, bobDeposit1, carolDeposit1] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))

      /*
     // console.log("aliceDeposit1", aliceDeposit1.toString())
     // console.log("aliceDeposit", (await stabilityPool.getCompoundedLUSDDeposit(alice)).toString())
     // console.log("bobDeposit1", bobDeposit1.toString())
     // console.log("bobDeposit", (await stabilityPool.getCompoundedLUSDDeposit(bob)).toString())
     // console.log("carolDeposit1", carolDeposit1.toString())
     // console.log("carolDeposit", (await stabilityPool.getCompoundedLUSDDeposit(carol)).toString())
      */

      total = aliceDeposit1.add(bobDeposit1).add(carolDeposit1)
     // console.log("expTotal", total.toString())
     // console.log("totalLUSD", (await stabilityPool.getTotalLUSDDeposits()).toString())

      // Dennis opens a trove and provides to SP
      dennisDeposit = toBN(dec(10000, 18))
      await lusdToken.transfer(dennis, dennisDeposit, { from: whale })
      await stabilityPool.provideToSP(dennisDeposit, ZERO_ADDRESS, { from: dennis })

      total = aliceDeposit1.add(bobDeposit1).add(carolDeposit1).add(dennisDeposit)
      //console.log("total", total.toString())
      //console.log("totalLUSD", (await stabilityPool.getTotalLUSDDeposits()).toString())

      // Third and fourth defaulters liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [finalAliceDeposit, finalBobDeposit, finalCarolDeposit, finalDennisDeposit] = (await th.depositsAfterTwoLiquidations(contracts, tx3, tx4, [aliceDeposit1, bobDeposit1, carolDeposit1, dennisDeposit]))

     // console.log("finalAliceDeposit", finalAliceDeposit.toString())
     // console.log("aliceDeposit", (await stabilityPool.getCompoundedLUSDDeposit(alice)).toString())
     // console.log("finalBobDeposit", finalBobDeposit.toString())
     // console.log("bobDeposit", (await stabilityPool.getCompoundedLUSDDeposit(bob)).toString())
     // console.log("finalCarolDeposit", finalCarolDeposit.toString())
     // console.log("carolDeposit", (await stabilityPool.getCompoundedLUSDDeposit(carol)).toString())
     // console.log("finalDennisDeposit", finalDennisDeposit.toString())
     // console.log("dennisDeposit", (await stabilityPool.getCompoundedLUSDDeposit(dennis)).toString())

      total = finalAliceDeposit.add(finalBobDeposit).add(finalCarolDeposit).add(finalDennisDeposit)
     // console.log("final total", total.toString())
     // console.log("final totalLUSD", (await stabilityPool.getTotalLUSDDeposits()).toString())

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(spDeposit, { from: alice })
      const txB = await stabilityPool.withdrawFromSP(spDeposit, { from: bob })
      const txC = await stabilityPool.withdrawFromSP(spDeposit, { from: carol })
      console.log("dennisDeposit " + dennisDeposit)
      console.log("total deposits "  + await stabilityPool.getTotalLUSDDeposits())
      const txD = await stabilityPool.withdrawFromSP(dennisDeposit, { from: dennis })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // 1/6, 1/6, 1/6 and 1/2 LUSD
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '166666666666660000'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '166666666666660000'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '166666666666660000'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '499999999999980000'), 100000)
     
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), finalAliceDeposit), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), finalBobDeposit), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), finalCarolDeposit), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), finalDennisDeposit), 2e15)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(995, 17)), 2e15)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 17)), 2e15)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(995, 17)), 2e15)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dec(995, 17)), 5e15)
    })

    it("withdrawFromSP(): A, B, C Deposit -> 2 liquidations -> D deposits -> 2 liquidations. Various deposit and liquidation vals.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 1m ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      /* Defaulters open troves:
      Defaulter 1:  10000 LUSD, 100 ETH
      Defaulter 2:  25000 LUSD, 250 ETH
      Defaulter 3:  5000 LUSD, 50 ETH
      Defaulter 4:  40000 LUSD, 400 ETH
      */

      defaulter_1_eth = toBN(dec(100, 'ether'))
      defaulter_2_eth = toBN(dec(250, 'ether'))
      defaulter_3_eth = toBN(dec(50, 'ether'))
      defaulter_4_eth = toBN(dec(400, 'ether'))
      await borrowerOperations.openTrove(defaulter_1_eth, await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(defaulter_2_eth, await getOpenTroveLUSDAmount(dec(25000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(defaulter_3_eth, await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3  })
      await borrowerOperations.openTrove(defaulter_4_eth, await getOpenTroveLUSDAmount(dec(40000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

      /* Depositors open troves and make SP deposit:
      Alice: 60000 LUSD
      Bob: 20000 LUSD
      Carol: 15000 LUSD
      */
      // Whale transfers LUSD to  A, B and C respectively who then deposit it to the SP
      aliceDeposit = toBN(dec(60000, 18))
      bobDeposit = toBN(dec(20000, 18))
      carolDeposit = toBN(dec(15000, 18))
      await lusdToken.transfer(alice, aliceDeposit, { from: whale })
      await stabilityPool.provideToSP(aliceDeposit, ZERO_ADDRESS, { from: alice })
      await lusdToken.transfer(bob, bobDeposit, { from: whale })
      await stabilityPool.provideToSP(bobDeposit, ZERO_ADDRESS, { from: bob })
      await lusdToken.transfer(carol, carolDeposit, { from: whale })
      await stabilityPool.provideToSP(carolDeposit, ZERO_ADDRESS, { from: carol })


      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain1, bobGain1, carolGain1, aliceDeposit1, bobDeposit1, carolDeposit1] = (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [aliceDeposit, bobDeposit, carolDeposit]))

      // Dennis provides 25000 LUSD
      const dennisDeposit = toBN(dec(25000, 18))
      await lusdToken.transfer(dennis, dennisDeposit, { from: whale })
      await stabilityPool.provideToSP(dennisDeposit, ZERO_ADDRESS, { from: dennis })

      // Last two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_4, { from: owner });
      //const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit, dennisFinalDeposit, whaleFinalDeposit] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, whaleDeposit]))
      const [aliceGain2, bobGain2, carolGain2, dennisGain2, aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] = (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [aliceDeposit1, bobDeposit1, carolDeposit1, dennisDeposit]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Each depositor withdraws as much as possible
      const txA = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: dennis })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '17832817337461300000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '5944272445820430000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '4458204334365320000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '11764705882352900000000'), 100000000000)

      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit2), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDeposit2), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolDeposit2), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisDeposit2), 3e15)


      // 3.5*0.995 * {60000,20000,15000,0} / 95000 + 450*0.995 * {60000/950*{60000,20000,15000},25000} / (120000-35000)
      //assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '419563467492260055900'), 100000000000)
      //assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '139854489164086692700'), 100000000000)
      //assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '104890866873065014000'), 100000000000)
      //assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, '131691176470588233700'), 100000000000)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, aliceGain1.add(aliceGain2)), 2e13)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, bobGain1.add(bobGain2)), 2e13)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, carolGain1.add(carolGain2)), 2e13)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dennisGain2), 2e13)

    })

    // --- Depositor leaves ---

    it("withdrawFromSP(): A, B, C, D deposit -> 2 liquidations -> D withdraws -> 2 liquidations. All deposits and liquidations = 100 LUSD.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

      // Whale transfers 10k LUSD to A, B and C who then deposit it to the SP
      const depositors = [alice, bob, carol, dennis]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // get deposits before for depositsAfterLiquidation()
      const aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      const bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      const carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      const dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      const whaleDeposit = await stabilityPool.getCompoundedLUSDDeposit(whale)

      // First two defaulters liquidated
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit, dennisFinalDeposit, whaleFinalDeposit] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, whaleDeposit]))

      // Dennis withdraws his deposit and ETH gain
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txD = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      // TODO: tighten
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisFinalDeposit), 1e14)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, '49750000000000000000'), 1e14)

      // Two more defaulters are liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      // TODO: tighten
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '333333333333330000'), 1e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '333333333333330000'), 1e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '333333333333330000'), 1e14)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(995, 17)), 5e15)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 17)), 5e15)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(995, 17)), 5e15)
    })

    it("withdrawFromSP(): A, B, C, D deposit -> 2 liquidations -> D withdraws -> 2 liquidations. Various deposit and liquidation vals. A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      /* Defaulters open troves:
      Defaulter 1: 10000 LUSD
      Defaulter 2: 20000 LUSD
      Defaulter 3: 30000 LUSD
      Defaulter 4: 5000 LUSD
      */
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(300, 'ether'), await getOpenTroveLUSDAmount(dec(30000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(toBN('50000000000000000000'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4})

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
      const [aliceDeposit1, bobDeposit1, carolDeposit1, dennisDeposit1] = (await th.depositsAfterTwoLiquidations(contracts, tx1, tx2, [aliceSpDeposit, bobSpDeposit, carolSpDeposit, dennisSpDeposit]))

      // Dennis withdraws his deposit and ETH gain
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txD = await stabilityPool.withdrawFromSP(dec(40000, 18), { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '27692307692307700000000'), 100000000000)
      // TODO: tighten
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisDeposit1), 1e15)
      // 300*0.995 * 40000/97500
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, '122461538461538466100'), 1e15)

      // Two more defaulters are liquidated
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [aliceDeposit2, bobDeposit2, carolDeposit2] = (await th.depositsAfterTwoLiquidations(contracts, tx3, tx4, [aliceDeposit1, bobDeposit1, carolDeposit1]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '1672240802675590000000'), 10000000000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '2090301003344480000000'), 100000000000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '1045150501672240000000'), 100000000000)

      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit2), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDeposit2), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolDeposit2), 2e15)

      // 300*0.995 * {20000,25000,12500}/97500 + 350*0.995 * {20000,25000,12500}/57500
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '182361204013377919900'), 1e14)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '227951505016722411000'), 1e14)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '113975752508361205500'), 1e14)
    })

    // --- One deposit enters at t > 0, and another leaves later ---
    it("withdrawFromSP(): A, B, D deposit -> 2 liquidations -> C makes deposit -> 1 liquidation -> D withdraws -> 1 liquidation. All deposits: 100 LUSD. Liquidations: 100,100,100,50.  A, B, C, D withdraw correct LUSD deposit and ETH Gain", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters open troves
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(toBN('50000000000000000000'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4})

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
      const [aliceGain1, bobGain1, dennisGain1, aliceDeposit1, bobDeposit1, dennisDeposit1] = (await th.depositorValuesAfterTwoLiquidations(contracts, tx1, tx2, [spDeposit, spDeposit, spDeposit]))

      // Carol makes deposit
      await lusdToken.transfer(carol, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: carol })

      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceGain2, bobGain2, carolGain2, dennisGain2, aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] = (await th.depositorValuesAfterLiquidation(contracts, tx3, [aliceDeposit1, bobDeposit1, spDeposit, dennisDeposit1]))

      // Dennis withdraws his deposit and ETH gain
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txD = await stabilityPool.withdrawFromSP(spDeposit, { from: dennis })
      await priceFeed.setPrice(dec(100, 18))

      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      // TODO: tighten
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisDeposit2), 1e15)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dennisGain1.add(dennisGain2)), 1e15)

      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });

      const [aliceGain3, bobGain3, carolGain3, aliceDeposit3, bobDeposit3, carolDeposit3] = (await th.depositorValuesAfterLiquidation(contracts, tx4, [aliceDeposit2, bobDeposit2, carolDeposit2]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(spDeposit, { from: alice })
      const txB = await stabilityPool.withdrawFromSP(spDeposit, { from: bob })
      const txC = await stabilityPool.withdrawFromSP(spDeposit, { from: carol })

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '666666666666666666666'), 100000)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '2000000000000000000000'), 100000)

      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit3), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDeposit3), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolDeposit3), 2e15)

      //assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, '92866666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, '92866666666666666667'), 100000)
      //assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '79600000000000000000'), 100000)

      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, aliceGain1.add(aliceGain2).add(aliceGain3)), 1e15)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, bobGain1.add(bobGain2).add(bobGain3)), 1e15)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, carolGain2.add(carolGain3)), 1e15)
    })

    // --- Tests for full offset - Pool empties to 0 ---

    // A, B deposit 10000
    // L1 cancels 20000, 200
    // C, D deposit 10000
    // L2 cancels 10000,100

    // A, B withdraw 0LUSD & 100e
    // C, D withdraw 5000LUSD  & 500e
    it("withdrawFromSP(): Depositor withdraws correct compounded deposit after liquidation empties the pool", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })
      // 2 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      // Whale transfers 10k LUSD to A, B who then deposit it to the SP
      const depositors = [alice, bob]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated. 20000 LUSD almost offset with pool.
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      const [aliceDeposit, bobDeposit] =  await th.depositsAfterLiquidation(contracts, tx, [spDeposit, spDeposit])

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      await priceFeed.setPrice(dec(100, 18));

      // Expect Alice And Bob's compounded deposit to be 1 LUSD combined
      // TODO: tighten
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), dec(5, 17)), 1e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), dec(5, 17)), 2e14)

      // Carol, Dennis each deposit 10000 LUSD
      const depositors_2 = [carol, dennis]
      for (account of depositors_2) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      // whale withdraws as it’s not needed anymore
      await stabilityPool.withdrawFromSP(dec(1, 18), { from: whale })
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 2 liquidated. 10000 LUSD offset
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [finalCarolDeposit, finalDennisDeposit] =  await th.depositsAfterLiquidation(contracts, tx2, [spDeposit, spDeposit])

      // await borrowerOperations.openTrove(dec(1, 18), account, account, false, { from: erin, value: dec(2, 'ether') })
      // await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: erin })

      // whale deposits 1 LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })

      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // Expect Alice and Bob's ETH Gain to be 100 ETH
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(995, 17)), 5e15)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 17)), 5e15)

      // Expect Carol And Dennis' compounded deposit to be 50 LUSD
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), dec(5000, 18)), 5e13)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dec(5000, 18)), 5e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), finalCarolDeposit), 4e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), finalDennisDeposit), 4e14)

      // Expect Carol and and Dennis ETH Gain to be 50 ETH
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '49750000000000000000'), 5e11)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, '49750000000000000000'), 9e11)
    })

    // A, B deposit 10000
    // L1 cancels 10000, 1
    // L2 10000, 200 empties Pool
    // C, D deposit 10000
    // L3 cancels 10000, 1 
    // L2 20000, 200 empties Pool
    it("withdrawFromSP(): Almost pool-emptying liquidation resets scaleFactor to 0, and resets P to 1e18", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      // 4 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

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
      const P_0 = await stabilityPool.P()

      assert.equal(scale_0, '0')
      assert.isTrue(P_0.gt(toBN(dec(1, 18))))

      // Defaulter 1 liquidated. 10000 LUSD fully offset, Pool remains non-zero
      liq1Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError1 = await stabilityPool.lastLUSDLossError_Offset()
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const [,drip1] = await th.getEmittedDripValues(contracts,tx1)
      var [liquidatedDebt1] = await th.getEmittedLiquidationValues(tx1)
      const expP_1 = await th.getNewPAfterLiquidation(contracts, tx1, P_0, liq1Deposits, lastLUSDError1)

      //Check scale and sum
      const scale_1 = (await stabilityPool.currentScale()).toString()
      const P_1 = await stabilityPool.P()

      assert.equal(scale_1, '0')
      assert.isAtMost(th.getDifference(P_1, expP_1), 1000)

      // Defaulter 2 liquidated. 10000 LUSD
      liq2Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError2 = await stabilityPool.lastLUSDLossError_Offset()
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [,drip2] = await th.getEmittedDripValues(contracts,tx2)
      var [liquidatedDebt2] = await th.getEmittedLiquidationValues(tx2)
      const expP_2 = await th.getNewPAfterLiquidation(contracts, tx2, P_1, liq2Deposits, lastLUSDError2)

      //Check scale and sum
      const scale_2 = (await stabilityPool.currentScale()).toString()
      const P_2 = await stabilityPool.P()


      assert.equal(scale_2, '0')
      // console.log("P_2", P_2.toString())
      //assert.isAtMost(th.getDifference(P_2, dec(5, 13)), 10)
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
      liq3Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError3 = await stabilityPool.lastLUSDLossError_Offset()
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [,drip3] = await th.getEmittedDripValues(contracts,tx3)
      var [liquidatedDebt3] = await th.getEmittedLiquidationValues(tx3)
     // console.log("drip3", drip3.toString())
     // console.log("liquidatedDebt3", liquidatedDebt3.toString())
      const expP_3 = await th.getNewPAfterLiquidation(contracts, tx3, P_2, liq3Deposits, lastLUSDError3)

      //Check scale and sum
      const scale_3 = (await stabilityPool.currentScale()).toString()
      const P_3 = await stabilityPool.P()
     // console.log("P_3", P_3.toString())
     // console.log("expP_3", expP_3.toString())

      assert.equal(scale_3, '0')
      //assert.isAtMost(th.getDifference(P_3, dec(25, 12)), 13e8)
      assert.isAtMost(th.getDifference(P_3, expP_3), 5e8)

      // Defaulter 4 liquidated. 10000 LUSD
      liq4Deposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError4 = await stabilityPool.lastLUSDLossError_Offset()
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [,drip4] = await th.getEmittedDripValues(contracts,tx4)
      var [liquidatedDebt4] = await th.getEmittedLiquidationValues(tx4)
     // console.log("drip4", drip4.toString())
     // console.log("liquidatedDebt4", liquidatedDebt4.toString())
      const expP_4 = await th.getNewPAfterLiquidation(contracts, tx4, P_3, liq4Deposits, lastLUSDError4)

      //Check scale and sum
      const scale_4 = (await stabilityPool.currentScale()).toString()
      const P_4 = await stabilityPool.P()

      assert.equal(scale_4, '0')
      assert.isAtMost(th.getDifference(P_4, dec(25, 8)), 13e4)
      assert.isAtMost(th.getDifference(P_4, expP_4), 13e4)

    })


    // A, B deposit 10000
    // L1 cancels 20000, 200
    // C, D, E deposit 10000, 20000, 30000
    // L2 cancels 10000,100 

    // A, B withdraw 0 LUSD & 100e
    // C, D withdraw 5000 LUSD  & 50e
    it("withdrawFromSP(): Depositors withdraw correct compounded deposit after liquidation almost empties the pool", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      // Whale transfers 10k LUSD to A, B who then deposit it to the SP
      const depositors = [alice, bob]
      for (account of depositors) {
        await lusdToken.transfer(account, dec(10000, 18), { from: whale })
        await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: account })
      }

      // 2 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated. 20000 LUSD fully offset with pool.
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      const [,drip] = await th.getEmittedDripValues(contracts,tx)
      const [liquidatedDebt] = await th.getEmittedLiquidationValues(tx)

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // price up temporarily to avoid underwater troves to block SP withdrawal
      await priceFeed.setPrice(dec(200, 18));
      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
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

      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(20000, 18), { from: dennis })
      const txE = await stabilityPool.withdrawFromSP(dec(30000, 18), { from: erin })

      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      const erin_CollateralWithdrawn = th.getEventArgByName(txE, 'CollateralGainWithdrawn', '_collateral').toString()

      // Expect Alice And Bob's compounded deposit to be 1 LUSD combined
      // TODO: tight tolerances by calculating drips from above provides and withdraws
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), dec(5, 17)), 1e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), dec(5, 17)), 2e13)

      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '8333333333333333333333'), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '16666666666666666666666'), 1e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(erin)).toString(), '25000000000000000000000'), 1e15)

      //Expect Alice and Bob's ETH Gain to be 1 ETH
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(995, 17)), 5e15)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 17)), 5e15)

      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, '16583333333333333333'), 1e13)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, '33166666666666666667'), 1e13)
      assert.isAtMost(th.getDifference(erin_CollateralWithdrawn, '49750000000000000000'), 1e13)
    })

    // A deposits 10000
    // L1, L2, L3 liquidated with 10000 LUSD each
    // A withdraws all
    // Expect A to withdraw 0 deposit and ether only from reward L1
    it("withdrawFromSP(): single deposit fully offset. After subsequent liquidations, depositor withdraws 0 deposit and *only* the ETH Gain from one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: alice })

      // Defaulter 1,2,3 withdraw 10000 LUSD
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount(dec(10000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1, 2  and 3 liquidated
      await liquidations.liquidate(defaulter_1, { from: owner });
      await liquidations.liquidate(defaulter_2, { from: owner });
      await liquidations.liquidate(defaulter_3, { from: owner });

      totalDeposits = await stabilityPool.getTotalLUSDDeposits()
      aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)

      // whale deposits 1 LUSD so all can exit
      tx = await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const [,drip] = await th.getEmittedDripValues(contracts, tx)

      aliceDrip = drip.mul(aliceDeposit).div(totalDeposits)
      aliceDeposit = aliceDeposit.add(aliceDrip)

      totalDeposits = totalDeposits.add(drip).add(toBN(dec(1,18)))

      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })

      const [,dripA] = await th.getEmittedDripValues(contracts, txA) 

      aliceDrip = dripA.mul(aliceDeposit).div(totalDeposits)
      aliceDeposit = aliceDeposit.add(aliceDrip)

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()

      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), aliceDeposit), 100000)
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(995, 17)), 1e16)
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

    it("withdrawFromSP(): Depositor withdraws correct compounded deposit after liquidation almost empties the pool", async () => {
      // Whale opens Trove with 100k ETH
      //await contracts.rateControl.setCoBias(0)
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // 4 Defaulters open trove with 200% ICR
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(20000, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

      // price drops by 50%: defaulter ICR falls to 100%
      await priceFeed.setPrice(dec(100, 18));

      // Alice, Bob each deposit 10k LUSD
      const depositors_1 = [alice, bob]
      spDeposit = toBN(dec(10000, 18))
      for (account of depositors_1) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)

      // Defaulter 1 liquidated. 20k LUSD fully offset with pool.
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      lastLUSDGainError = await stabilityPool.lastLUSDGainError()
      tx1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const [aliceGain1, bobGain1, aliceDeposit1, bobDeposit1] = await th.depositorValuesAfterLiquidation(contracts, tx1, [aliceDeposit, bobDeposit])

      const stabilityPoolInterface = (await ethers.getContractAt("StabilityPool", contracts.stabilityPool.address)).interface;
      var debtToOffset = th.toBN(await th.getRawEventArgByName(tx1, stabilityPoolInterface, contracts.stabilityPool.address, "Offset", "debtToOffset"))

      // Carol, Dennis each deposit 10000 LUSD
      const depositors_2 = [carol, dennis]
      for (account of depositors_2) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)

      // Defaulter 2 liquidated. 10000 LUSD offset
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      lastLUSDGainError = await stabilityPool.lastLUSDGainError()
      tx2 = await liquidations.liquidate(defaulter_2, { from: owner });
      const [aliceGain2, bobGain2, carolGain2, dennisGain2,
             aliceDeposit2, bobDeposit2, carolDeposit2, dennisDeposit2] = await th.depositorValuesAfterLiquidation(contracts, tx2, [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit])

      // Erin, Flyn each deposit 10000 LUSD
      const depositors_3 = [erin, flyn]
      for (account of depositors_3) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      erinDeposit = await stabilityPool.getCompoundedLUSDDeposit(erin)
      flynDeposit = await stabilityPool.getCompoundedLUSDDeposit(flyn)

      // Defaulter 3 liquidated. 10000 LUSD offset
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      lastLUSDGainError = await stabilityPool.lastLUSDGainError()
      tx3 = await liquidations.liquidate(defaulter_3, { from: owner });
      const [aliceGain3, bobGain3, carolGain3, dennisGain3, erinGain3, flynGain3,
             aliceDeposit3, bobDeposit3, carolDeposit3, dennisDeposit3, ericDeposit3, flynDeposit3] =
            await th.depositorValuesAfterLiquidation(contracts, tx3,
                [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, erinDeposit, flynDeposit])

      // Graham, Harriet each deposit 10000 LUSD
      const depositors_4 = [graham, harriet]
      for (account of depositors_4) {
        await lusdToken.transfer(account, spDeposit, { from: whale })
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      erinDeposit = await stabilityPool.getCompoundedLUSDDeposit(erin)
      flynDeposit = await stabilityPool.getCompoundedLUSDDeposit(flyn)
      grahamDeposit = await stabilityPool.getCompoundedLUSDDeposit(graham)
      harrietDeposit = await stabilityPool.getCompoundedLUSDDeposit(harriet)

      // Defaulter 4 liquidated. 10k LUSD offset
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      lastLUSDGainError = await stabilityPool.lastLUSDGainError()
      tx4 = await liquidations.liquidate(defaulter_4, { from: owner });
      const [aliceGain4, bobGain4, carolGain4, dennisGain4, erinGain4, flynGain4, grahamGain4, harrietGain4,
             aliceDeposit4, bobDeposit4, carolDeposit4, dennisDeposit4, erinDeposit4, flynDeposit4, grahamDeposit4, harrietDeposit4] =
            await th.depositorValuesAfterLiquidation(contracts, tx2,
                [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, erinDeposit, flynDeposit, grahamDeposit, harrietDeposit])

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })
      const txE = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: erin })
      const txF = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: flyn })
      const txG = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: graham })
      const txH = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: harriet })

      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()
      const erin_CollateralWithdrawn = th.getEventArgByName(txE, 'CollateralGainWithdrawn', '_collateral').toString()
      const flyn_CollateralWithdrawn = th.getEventArgByName(txF, 'CollateralGainWithdrawn', '_collateral').toString()
      const graham_CollateralWithdrawn = th.getEventArgByName(txG, 'CollateralGainWithdrawn', '_collateral').toString()
      const harriet_CollateralWithdrawn = th.getEventArgByName(txH, 'CollateralGainWithdrawn', '_collateral').toString()

      console.log("total deposits " +  await stabilityPool.getTotalLUSDDeposits())
      console.log("whale deposit " + await stabilityPool.getCompoundedLUSDDeposit(whale))

      // Expect all deposits to be almost 0 LUSD
      // th.depositorValuesAfterLiquidation() does not exactly replicate rounding or error corrections
      // so using it's incorrect outputs in above sequence causes growing error 
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(alice)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), '0'), 100000)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(erin)).toString(), '0'), 1e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(flyn)).toString(), '0'), 1e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(graham)).toString(), 5e17), 2e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(harriet)).toString(), 5e17), 2e15)

      /* Expect all ETH gains to be 100 ETH:  Since each liquidation of almost empties the pool, depositors
      should only earn ETH from the single liquidation that cancelled with their deposit minus the 1 LUSD */
      //assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, dec(995, 17)), 300000)
      //assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 17)), 300000)
      //assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(995, 17)), 5000000000)
      //assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dec(995, 17)), 5000000000)
      //assert.isAtMost(th.getDifference(erin_CollateralWithdrawn, dec(995, 17)), 5e12)
      //assert.isAtMost(th.getDifference(flyn_CollateralWithdrawn, dec(995, 17)), 5e12)
      //assert.isAtMost(th.getDifference(graham_CollateralWithdrawn, dec(995, 17)), 5e16)
      //assert.isAtMost(th.getDifference(harriet_CollateralWithdrawn, dec(995, 17)), 5e16)

      aliceFinalGain = aliceGain1.add(aliceGain2).add(aliceGain3).add(aliceGain4)
      bobFinalGain = bobGain1.add(bobGain2).add(bobGain3).add(bobGain4)
      carolFinalGain = (carolGain2).add(carolGain3).add(carolGain4)
      dennisFinalGain = (dennisGain2).add(dennisGain3).add(dennisGain4)
      erinFinalGain = (erinGain3).add(erinGain4)
      flynFinalGain = (flynGain3).add(flynGain4)

      // TODO had to increase tolerance for alice and bob
      assert.isAtMost(th.getDifference(alice_CollateralWithdrawn, aliceFinalGain), 13000000)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, bobFinalGain), 13000000)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, carolFinalGain), 5000000000)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dennisFinalGain), 5000000000)
      assert.isAtMost(th.getDifference(erin_CollateralWithdrawn, erinFinalGain), 5e12)
      assert.isAtMost(th.getDifference(flyn_CollateralWithdrawn, flynFinalGain), 5e12)
      assert.isAtMost(th.getDifference(graham_CollateralWithdrawn, grahamGain4), 5e16)
      assert.isAtMost(th.getDifference(harriet_CollateralWithdrawn, harrietGain4), 5e16)
    })

    // --- Scale factor tests ---

    // A deposits 10000
    // L1 brings P close to boundary, i.e. 9e-9: liquidate 9999.99991
    // A withdraws all
    // B deposits 10000
    // L2 of 9900 LUSD, should bring P slightly past boundary i.e. 1e-9 -> 1e-10

    // expect d(B) = d0(B)/100
    // expect correct ETH gain, i.e. all of the reward
    it("withdrawFromSP(): deposit spans one scale factor change: Single depositor withdraws correct compounded deposit and ETH Gain after one liquidation, #1", async () => {
      // Whale opens Trove with 1e9 ETH
      await borrowerOperations.openTrove(dec(1e9, 'ether'), await getOpenTroveLUSDAmount(dec(1e11, 18)), whale, whale, false, { from: whale })

      // Defaulter 1 withdraws 'almost' 1e9 LUSD:  999999991 LUSD
      await borrowerOperations.openTrove(dec(1e7, 'ether'), await getOpenTroveLUSDAmount(dec(999999991, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      // Defaulter 2 withdraws 9900 LUSD
      //await borrowerOperations.openTrove(await getOpenTroveLUSDAmount(dec(99e7, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2, value: dec(1e7, 'ether') })
      // Need to withdraw slightly more debt to ensure P drops below SCALE_FACTOR and scale increases
      await borrowerOperations.openTrove(dec(1e7, 'ether'), await getOpenTroveLUSDAmount(dec(9999e5, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      await lusdToken.transfer(alice, dec(1e9, 18), { from: whale })
      await stabilityPool.provideToSP(dec(1e9, 18), ZERO_ADDRESS, { from: alice })

      assert.equal(await stabilityPool.currentScale(), '0')

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));


      const P_0 = await stabilityPool.P()

      // Defaulter 1 liquidated.  Value of P reduced to 9e9.
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      const [,drip] = await th.getEmittedDripValues(contracts,tx)
      const exp_P_1 = await th.getNewPAfterLiquidation(contracts, tx, P_0, liqDeposits, lastLUSDError)

      const P_1 = await stabilityPool.P()

      assert.isTrue(P_1.eq(exp_P_1))
      //assert.equal((await stabilityPool.P()).toString(), dec(9, 9))

      // whale deposits LUSD so Alice can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(1e9, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = await th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()

      bobSpDeposit = toBN(dec(1e9, 18))
      await lusdToken.transfer(bob, bobSpDeposit, { from: whale })
      await stabilityPool.provideToSP(bobSpDeposit, ZERO_ADDRESS, { from: bob })

      // Defaulter 2 liquidated.  9900 LUSD liquidated. P altered by a factor of 1-(99e7/1e9) = 0.01.  Scale changed.
      tx = await liquidations.liquidate(defaulter_2, { from: owner });
      bobDepositAfter = await stabilityPool.getCompoundedLUSDDeposit(bob)

     // console.log('(await stabilityPool.P()).toString: ', (await stabilityPool.P()).toString())
      assert.equal(await stabilityPool.currentScale(), '1')

      // whale deposits LUSD so Bob can exit
      txP = await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      const [,dripP] = await th.getEmittedDripValues(contracts, txP)

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))

      const txB = await stabilityPool.withdrawFromSP(dec(1e9, 18), { from: bob })
      const [,dripB] = await th.getEmittedDripValues(contracts, txB)  
      const bob_CollateralWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()

      bobDepositAfter = bobDepositAfter.add(dripP).add(dripB)

      // Expect Bob to withdraw 1% of initial deposit (1e7 LUSD) and almost all the liquidated ETH
      assert.isAtMost(th.getDifference(await lusdToken.balanceOf(bob), dec(1e5, 18)), 50e18)
      assert.isAtMost(th.getDifference(await lusdToken.balanceOf(bob), bobDepositAfter), 1e18)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(1e7, 18)), 6e22)
    })

    // A deposits 10000
    // L1 brings P close to boundary, i.e. 9e-9: liquidate 9999.99991 LUSD
    // A withdraws all
    // B, C, D deposit 10000, 20000, 30000
    // L2 of 59400, should bring P slightly past boundary i.e. 1e-9 -> 1e-10

    // expect d(B) = d0(B)/100
    // expect correct ETH gain, i.e. all of the reward
    it("withdrawFromSP(): Several deposits of varying amounts span one scale factor change. Depositors withdraw correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 1e9 ETH
      await borrowerOperations.openTrove(dec(1e9, 'ether'), await getOpenTroveLUSDAmount(dec(1e11, 18)), whale, whale, false, { from: whale })

      // Defaulter 1 withdraws 'almost' 1e9 LUSD.
      await borrowerOperations.openTrove(dec(1e7, 'ether'), await getOpenTroveLUSDAmount(dec(999999999, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })

      // Defaulter 2 withdraws 594e7 LUSD
      //await borrowerOperations.openTrove(await getOpenTroveLUSDAmount(dec(594e7, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2, value: dec(6e7, 'ether') })
      // slightly increase debt to ensure scale change
      await borrowerOperations.openTrove(dec(6e7, 'ether'), await getOpenTroveLUSDAmount(dec(600e7, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      await lusdToken.transfer(alice, dec(1e9, 18), { from: whale })
      await stabilityPool.provideToSP(dec(1e9, 18), ZERO_ADDRESS, { from: alice })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated.  Value of P reduced to 9e9
      P_0 = (await stabilityPool.P())
      assert.isTrue(P_0.eq(toBN(dec(1,18))))
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      const expP_1 = await th.getNewPAfterLiquidation(contracts, tx, P_0, liqDeposits, lastLUSDError)
      assert.isTrue((await stabilityPool.P()).eq(expP_1))

      assert.equal(await stabilityPool.currentScale(), '0')

      // whale deposits LUSD so Alice can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(1e9, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))

      //B, C, D deposit to Stability Pool
      await lusdToken.transfer(bob, dec(1e9, 18), { from: whale })
      await stabilityPool.provideToSP(dec(1e9, 18), ZERO_ADDRESS, { from: bob })

      await lusdToken.transfer(carol, dec(2e9, 18), { from: whale })
      await stabilityPool.provideToSP(dec(2e9, 18), ZERO_ADDRESS, { from: carol })

      await lusdToken.transfer(dennis, dec(3e9, 18), { from: whale })
      await stabilityPool.provideToSP(dec(3e9, 18), ZERO_ADDRESS, { from: dennis })

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
      assert.equal(await stabilityPool.currentScale(), '1')

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))

      const txB = await stabilityPool.withdrawFromSP(dec(1e9, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(2e9, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(3e9, 18), { from: dennis })

      // V1 comment
      /* Expect depositors to withdraw 1% of their initial deposit, and an ETH gain 
      in proportion to their initial deposit:
     
      Bob:  1000 LUSD, 55 Ether
      Carol:  2000 LUSD, 110 Ether
      Dennis:  3000 LUSD, 165 Ether
     
      Total: 6000 LUSD, 300 Ether
      */
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), dec(1e7, 18)), 1e18)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), dec(2e7, 18)), 1e18)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dec(3e7, 18)), 1e18)
      
      // TODO: decrease tolerance by accounting for drips in above provide and withdraws
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobFinalDeposit), 4e18)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolFinalDeposit), 11e18)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisFinalDeposit), 24e18)

      const bob_CollateralWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = await th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = await th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

     // console.log("bob_CollateralWithdrawn", bob_CollateralWithdrawn.toString())
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(1e7, 18)), 1e23)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(2e7, 18)), 11e22)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dec(3e7, 18)), 16e22)
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
    it("withdrawFromSP(): deposit spans one scale factor change: Single depositor withdraws correct compounded deposit and ETH Gain after one liquidation, #2", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulter 1 and default 2 each withdraw 9999.999999999 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

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
      P1 = await stabilityPool.P()

     // console.log("P1", P1.toString())
     // console.log("expP1", expP1.toString())
      assert.isTrue(P1.eq(expP1))

      //assert.equal(await stabilityPool.P(), dec(1, 13)) // P changes to 1e(18-5) = 1e13
      assert.equal(await stabilityPool.currentScale(), '0')

      // Alice withdraws
      // whale deposits LUSD so Alice can exit
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

      P1 = await stabilityPool.P()

      // Defaulter 2 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      bobDepositAfter =  (await th.depositsAfterLiquidation(contracts, txL2, [bobSpDeposit, otherDep]))[0]
      P2 = await stabilityPool.P()
      const expP2 = await th.getNewPAfterLiquidation(contracts, txL2, P1, liqDeposits, lastLUSDError)


      assert.isTrue(txL2.receipt.status)
      //assert.equal(await stabilityPool.P(), dec(1, 17))  // Scale changes and P changes. P = 1e(13-5+9) = 1e17
      // TODO: fix the increased tolerance
      //assert.isAtMost(th.getDifference((await stabilityPool.P()).toString(), dec(1, 17)), 23e13)
      assert.isTrue(P2.div(toBN(dec(1,9))).eq(expP2))

      assert.equal(await stabilityPool.currentScale(), '1')

      // whale deposits LUSD so Bob can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

     // console.log("getTotal", (await stabilityPool.getTotalLUSDDeposits()).toString())
      const txB = await stabilityPool.withdrawFromSP(dec(99999, 18), { from: bob })
      const bob_CollateralWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()

      // Bob should withdraw 1e-5 of initial deposit: 1 LUSD and almost the full ETH gain of 100 ether
      // increased tolerance to account for drips in whale provide and bob withdraw
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), dec(1, 18)), 2e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobDepositAfter), 2e14)
      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 18)), 1e17)
    })

    // A make deposit 10000 LUSD
    // L1 brings P to 1e-5*P. L1:  99999 LUSD
    // A withdraws
    // B,C D make deposit 10000, 20000, 30000
    // L2 decreases P again by 1e-5, over boundary. L2: 599994  (near to the 600000 LUSD total deposits)
    // B withdraws
    // expect d(B) = d0(B) * 1e-5
    // expect B gets entire ETH gain from L2
    it("withdrawFromSP(): Several deposits of varying amounts span one scale factor change. Depositors withdraws correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulter 1 and default 2 withdraw up to debt of 99999 LUSD and 599994 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(6000, 'ether'), await getOpenTroveLUSDAmount(dec(599994, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })

      await lusdToken.transfer(alice, dec(100000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: alice })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // Defaulter 1 liquidated.  Value of P updated to  to 9999999, i.e. in decimal, ~1e-10
      P_0 = (await stabilityPool.P())
      assert.isTrue(P_0.eq(toBN(dec(1,18))))
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      const expP_1 = await th.getNewPAfterLiquidation(contracts, txL1, P_0, liqDeposits, lastLUSDError)
      assert.isTrue((await stabilityPool.P()).eq(expP_1))
      assert.equal(await stabilityPool.currentScale(), '0')

      // Alice withdraws
      // whale deposits LUSD so Alice can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(100, 18), { from: alice })
      await priceFeed.setPrice(dec(100, 18))

      // B, C, D deposit 100000, 200000, 300000 LUSD
      await lusdToken.transfer(bob, dec(100000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: bob })

      await lusdToken.transfer(carol, dec(200000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(200000, 18), ZERO_ADDRESS, { from: carol })

      await lusdToken.transfer(dennis, dec(300000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(300000, 18), ZERO_ADDRESS, { from: dennis })

      // get deposits before for depositsAfterLiquidation()
      const aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      const bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      const carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      const dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      const whaleDeposit = await stabilityPool.getCompoundedLUSDDeposit(whale)

      // Defaulter 2 liquidated
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      assert.equal(await stabilityPool.currentScale(), '1')


      const [aliceFinalDeposit, bobFinalDeposit, carolFinalDeposit, dennisFinalDeposit, whaleFinalDeposit] = (await th.depositsAfterLiquidation(contracts, txL2, [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, whaleDeposit]))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txB = await stabilityPool.withdrawFromSP(dec(100000, 18), { from: bob })
      const bob_CollateralWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()

      const txC = await stabilityPool.withdrawFromSP(dec(200000, 18), { from: carol })
      const carol_CollateralWithdrawn = await th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()

      const txD = await stabilityPool.withdrawFromSP(dec(300000, 18), { from: dennis })
      const dennis_CollateralWithdrawn = await th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // {B, C, D} should have a compounded deposit of {1+1/6, 2+1/3, 3+1/2} LUSD
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), dec(116666, 13)), 1e13)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), dec(233333, 13)), 1e14)
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dec(35, 17)), 1e13)

      // TODO: calc exact deposits w/ drips
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(bob)).toString(), bobFinalDeposit), 3e13)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(carol)).toString(), carolFinalDeposit), 1e14)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dennisFinalDeposit), 2e14)

      assert.isAtMost(th.getDifference(bob_CollateralWithdrawn, dec(995, 18)), 1e16)
      assert.isAtMost(th.getDifference(carol_CollateralWithdrawn, dec(1990, 18)), 1e16)
      assert.isAtMost(th.getDifference(dennis_CollateralWithdrawn, dec(2985, 18)), 1e16)
    })

    // A make deposit 10000 LUSD
    // L1 brings P to (~1e-10)*P. L1: 9999.9999999000000000 LUSD
    // Expect A to withdraw 0 deposit
    it("withdrawFromSP(): Deposit that decreases to less than 1e-9 of it's original value is reduced to 1", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      // Defaulters 1 withdraws 9999.9999999 LUSD
      await borrowerOperations.openTrove(dec(100, 'ether'), await getOpenTroveLUSDAmount('9999999999900000000000'), defaulter_1, defaulter_1, false, { from: defaulter_1 })

      // Price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      await lusdToken.transfer(alice, dec(10000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(10000, 18), ZERO_ADDRESS, { from: alice })

      // Defaulter 1 liquidated. P -> (~1e-10)*P
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)

      const aliceDeposit = (await stabilityPool.getCompoundedLUSDDeposit(alice)).toString()
      //console.log(`alice deposit: ${aliceDeposit}`)
      assert.isAtMost(th.getDifference(aliceDeposit, toBN(dec(1, 18))), 10000)
    })

    // --- Serial scale changes ---

    /* A make deposit 10000 LUSD
    L1 brings P to 0.0001P. L1:  9999.900000000000000000 LUSD, 1 ETH
    B makes deposit 9999.9, brings SP to 10k
    L2 decreases P by(~1e-5)P. L2:  9999.900000000000000000 LUSD, 1 ETH
    C makes deposit 9999.9, brings SP to 10k
    L3 decreases P by(~1e-5)P. L3:  9999.900000000000000000 LUSD, 1 ETH
    D makes deposit 9999.9, brings SP to 10k
    L4 decreases P by(~1e-5)P. L4:  9999.900000000000000000 LUSD, 1 ETH
    expect A, B, C, D each withdraw ~100 Ether
    */
    it("withdrawFromSP(): Several deposits of 10000 LUSD span one scale factor change. Depositors withdraws correct compounded deposit and ETH Gain after one liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters 1-4 each withdraw 99999 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      await lusdToken.transfer(alice, dec(100000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: alice })

      // Defaulter 1 liquidated. 
      P0 = (await stabilityPool.P())
      assert.isTrue(P0.eq(toBN(dec(1,18))))
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)
      const expP1 = await th.getNewPAfterLiquidation(contracts, txL1, P0, liqDeposits, lastLUSDError)
      P1 = await stabilityPool.P()
      assert.equal(await stabilityPool.currentScale(), '0')
      assert.isTrue(P1.eq(expP1))

      // B deposits 99999 LUSD
      await lusdToken.transfer(bob, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: bob })

      P1 = await stabilityPool.P()
      // Defaulter 2 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      const expP2 = await th.getNewPAfterLiquidation(contracts, txL2, P1, liqDeposits, lastLUSDError)
      P2 = await stabilityPool.P()
      assert.equal(await stabilityPool.currentScale(), '1')
      assert.isTrue(P2.div(toBN(dec(1,9))).eq(expP2))

      // C deposits 99999 LUSD
      await lusdToken.transfer(carol, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: carol })

      P2 = await stabilityPool.P()
      // Defaulter 3 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL3 = await liquidations.liquidate(defaulter_3, { from: owner });
      assert.isTrue(txL3.receipt.status)
      const expP3 = await th.getNewPAfterLiquidation(contracts, txL3, P2, liqDeposits, lastLUSDError)
      P3 = await stabilityPool.P()
      assert.equal(await stabilityPool.currentScale(), '1')

      // D deposits 99999 LUSD
      await lusdToken.transfer(dennis, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: dennis })

      const aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      const bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      const carolDeposit = await stabilityPool.getCompoundedLUSDDeposit(carol)
      const dennisDeposit = await stabilityPool.getCompoundedLUSDDeposit(dennis)
      const whaleDeposit = await stabilityPool.getCompoundedLUSDDeposit(whale)
      total = await stabilityPool.getTotalLUSDDeposits()

      P3 = await stabilityPool.P()
      // Defaulter 4 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL4 = await liquidations.liquidate(defaulter_4, { from: owner });
      assert.isTrue(txL4.receipt.status)
      const expP4 = await th.getNewPAfterLiquidation(contracts, txL4, P3, liqDeposits, lastLUSDError)
      const P4 = await stabilityPool.P()
      assert.isTrue(P4.div(toBN(dec(1,9))).eq(expP4))

      assert.equal(await stabilityPool.currentScale(), '2')

      const [finalAliceDeposit, finalBobDeposit, finalCarolDeposit, finalDennisDeposit, finalWhaleDeposit] = await th.depositsAfterLiquidation(contracts, txL4, [aliceDeposit, bobDeposit, carolDeposit, dennisDeposit, whaleDeposit], total)

      expTotalFinal = finalAliceDeposit.add(finalBobDeposit)
      total = await stabilityPool.getTotalLUSDDeposits()

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      const txA = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: alice })
      const txB = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: bob })
      const txC = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: carol })
      const txD = await stabilityPool.withdrawFromSP(dec(10000, 18), { from: dennis })

      const alice_CollateralWithdrawn = await th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral').toString()
      const bob_CollateralWithdrawn = await th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral').toString()
      const carol_CollateralWithdrawn = await th.getEventArgByName(txC, 'CollateralGainWithdrawn', '_collateral').toString()
      const dennis_CollateralWithdrawn = await th.getEventArgByName(txD, 'CollateralGainWithdrawn', '_collateral').toString()

      // A, B, C should withdraw 0 - their deposits have been completely used up
      assert.equal(await lusdToken.balanceOf(alice), '0')
      assert.equal(await lusdToken.balanceOf(bob), '0')
      assert.equal(await lusdToken.balanceOf(carol), '0')

      // D should withdraw around 0.9999 LUSD, since his deposit of 99999 was reduced by a factor of 1e-5
      //assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dec(99999, 13)), 100000)
      // TODO consider drips in above provide and withdraws and reduce this tolerance
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), dec(99999, 13)), 3e15)
      assert.isAtMost(th.getDifference((await lusdToken.balanceOf(dennis)).toString(), finalDennisDeposit), 3e14)

      // 995 ETH is offset at each L, 0.5 goes to gas comp
      // Each depositor gets ETH rewards of around 995 ETH - 1e17 error tolerance
      assert.isTrue(toBN(alice_CollateralWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
      assert.isTrue(toBN(bob_CollateralWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
      assert.isTrue(toBN(carol_CollateralWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
      assert.isTrue(toBN(dennis_CollateralWithdrawn).sub(toBN(dec(995, 18))).abs().lte(toBN(dec(1, 17))))
    })

    it("withdrawFromSP(): 2 depositors can withdraw after each receiving half of an almost pool-emptying liquidation", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      // Defaulters 1-3 each withdraw 24100, 24300, 24500 LUSD (inc gas comp)
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(24100, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(24300, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(200, 'ether'), await getOpenTroveLUSDAmount(dec(24500, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      // A, B provide 10k LUSD 
      spDeposit = toBN(dec(10000, 18))
      await lusdToken.transfer(A, spDeposit, { from: whale })
      await lusdToken.transfer(B, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: A })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: B })

      // Defaulter 1 liquidated. SP emptied
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)

      // Check compounded deposits
      const A_deposit = await stabilityPool.getCompoundedLUSDDeposit(A)
      const B_deposit = await stabilityPool.getCompoundedLUSDDeposit(B)

      // B provided after A
      assert.isTrue(B_deposit.lt(A_deposit))

      // TODO: tolerance is loosened to account for drips in provides
      assert.isAtMost(th.getDifference(A_deposit, toBN(dec(5, 17))), 2e10)
      assert.isAtMost(th.getDifference(B_deposit, toBN(dec(5, 17))), 2e10)

      // Check SP tracker is 1
      const LUSDinSP_1 = await stabilityPool.getTotalLUSDDeposits()

      // There is 1 wei difference due to rounding down of totalActualDebtToOffset in liquidations.batchLiquidate()
      // when converting norm debt to actual
      assert.equal(LUSDinSP_1, dec(1, 18))

      // Check SP LUSD balance is 1
      const SPLUSDBalance_1 = await lusdToken.balanceOf(stabilityPool.address)
      assert.isTrue(SPLUSDBalance_1.eq(toBN(dec(1, 18))))

      // Attempt withdrawals
      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })

      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))
      const txA = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: A })
      const txB = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: B })
      await priceFeed.setPrice(dec(100, 18))

      assert.isTrue(txA.receipt.status)
      assert.isTrue(txB.receipt.status)

      // ==========

      // C, D provide 10k LUSD 
      await lusdToken.transfer(C, spDeposit, { from: whale })
      await lusdToken.transfer(D, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: C })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: D })


      // Defaulter 2 liquidated.  SP emptied
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      /*
      const [A_Deposit2,
             B_Deposit2,
             C_Deposit2,
             D_Deposit2,
             E_Deposit2,
             F_Deposit2,
             whale_Deposit2] = (await th.depositsAfterLiquidation(contracts, txL2, allDeposits2, total2))
      */

      // Check compounded deposits
      const C_deposit = await stabilityPool.getCompoundedLUSDDeposit(C)
      const D_deposit = await stabilityPool.getCompoundedLUSDDeposit(D)

      assert.isTrue(D_deposit.lt(C_deposit))
      assert.isAtMost(th.getDifference(C_deposit, toBN(dec(5, 17))), 2e14)
      assert.isAtMost(th.getDifference(D_deposit, toBN(dec(5, 17))), 2e14)

      // Check SP tracker is 1
      const LUSDinSP_2 = await stabilityPool.getTotalLUSDDeposits()
      //// console.log(`LUSDinSP_2: ${LUSDinSP_2}`)
      assert.equal(LUSDinSP_2, dec(1, 18))

      // Check SP LUSD balance is 1
      const SPLUSDBalance_2 = await lusdToken.balanceOf(stabilityPool.address)
      //// console.log(`SPLUSDBalance_2: ${SPLUSDBalance_2}`)
      assert.equal(SPLUSDBalance_2, dec(1, 18))

      // Attempt withdrawals
      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      // Increasing the price for a moment to avoid pending liquidations to block withdrawal
      await priceFeed.setPrice(dec(200, 18))

      const txC = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: C })
      const txD = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: D })
      assert.isTrue(txC.receipt.status)
      assert.isTrue(txD.receipt.status)

      await priceFeed.setPrice(dec(100, 18))

      // ============

      // E, F provide 10k LUSD 
      await lusdToken.transfer(E, spDeposit, { from: whale })
      await lusdToken.transfer(F, spDeposit, { from: whale })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: E })
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: F })

      total = await stabilityPool.getTotalLUSDDeposits()
      const allDeposits = [await stabilityPool.getCompoundedLUSDDeposit(A),
                           await stabilityPool.getCompoundedLUSDDeposit(B),
                           await stabilityPool.getCompoundedLUSDDeposit(C),
                           await stabilityPool.getCompoundedLUSDDeposit(D),
                           await stabilityPool.getCompoundedLUSDDeposit(E),
                           await stabilityPool.getCompoundedLUSDDeposit(F),
                           await stabilityPool.getCompoundedLUSDDeposit(whale)] 

      // Defaulter 3 liquidated. SP emptied
      const txL3 = await liquidations.liquidate(defaulter_3, { from: owner });
      assert.isTrue(txL3.receipt.status)

      const [A_finalDeposit,
             B_finalDeposit,
             C_finalDeposit,
             D_finalDeposit,
             E_finalDeposit,
             F_finalDeposit,
             whale_finalDeposit] = (await th.depositsAfterLiquidation(contracts, txL3, allDeposits))

      // Check compounded deposits
      const E_deposit = await stabilityPool.getCompoundedLUSDDeposit(E)
      const F_deposit = await stabilityPool.getCompoundedLUSDDeposit(F)

      assert.isAtMost(th.getDifference(E_deposit, E_finalDeposit), 1e12)
      assert.isAtMost(th.getDifference(F_deposit, E_finalDeposit), 1e12)

      // Check SP tracker is 1
      const LUSDinSP_3 = await stabilityPool.getTotalLUSDDeposits()
      assert.equal(LUSDinSP_3, dec(1, 18))

      // Check SP LUSD balance is 1
      const SPLUSDBalance_3 = await lusdToken.balanceOf(stabilityPool.address)
      assert.equal(SPLUSDBalance_3, dec(1, 18))

      // Attempt withdrawals
      //await assertRevert(stabilityPool.withdrawFromSP(dec(1000, 18), { from: E }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")
      //await assertRevert(stabilityPool.withdrawFromSP(dec(1000, 18), { from: F }), "Withdrawal must leave totalBoldDeposits >= MIN_LUSD_IN_SP")


      // E withdraws
      balanceBeforeE = await lusdToken.balanceOf(E)
      await stabilityPool.withdrawFromSP(dec(1000, 18), { from: E })
      balanceAfter = await lusdToken.balanceOf(E)

      balanceDiff = balanceAfter.sub(balanceBeforeE)
       // the withdraw when available to withdraw=0, drips fees so available becomes > 0
      // TODO calc exact drip from withdraw
      assert.isTrue(balanceDiff.lt(toBN(1e13)))

      // F withdraws
      balanceBeforeF = await lusdToken.balanceOf(F)
      await stabilityPool.withdrawFromSP(dec(1000, 18), { from: F })
      balanceAfter = await lusdToken.balanceOf(F)

      balanceDiff = balanceAfter.sub(balanceBeforeF)
       // the withdraw when available to withdraw=0, drips fees so available becomes > 0
      // TODO calc exact drip from withdraw
      assert.isTrue(balanceDiff.lt(toBN(1e13)))

      // whale deposits LUSD so all can exit
      await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      const txE = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: E })
      const txF = await stabilityPool.withdrawFromSP(dec(1000, 18), { from: F })
      assert.isTrue(txE.receipt.status)
      assert.isTrue(txF.receipt.status)

      assert.isTrue((await lusdToken.balanceOf(E)).gt(balanceBeforeE))
      assert.isTrue((await lusdToken.balanceOf(F)).gt(balanceBeforeF))
    })

    it("withdrawFromSP(): Depositor's ETH gain stops increasing after two scale changes", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(1000000, 'ether'), await getOpenTroveLUSDAmount(dec(1000000, 18)), whale, whale, false, { from: whale })

      // Defaulters 1-5 each withdraw up to debt of 99999 LUSD
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_2, defaulter_2, false, { from: defaulter_2 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_3, defaulter_3, false, { from: defaulter_3 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_4, defaulter_4, false, { from: defaulter_4 })
      await borrowerOperations.openTrove(dec(1000, 'ether'), await getOpenTroveLUSDAmount(dec(99999, 18)), defaulter_5, defaulter_5, false, { from: defaulter_5 })

      // price drops by 50%
      await priceFeed.setPrice(dec(100, 18));

      await lusdToken.transfer(alice, dec(100000, 18), { from: whale })
      await stabilityPool.provideToSP(dec(100000, 18), ZERO_ADDRESS, { from: alice })

      // Defaulter 1 liquidated. 
      P_0 = (await stabilityPool.P())
      assert.isTrue(P_0.eq(toBN(dec(1,18))))
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL1 = await liquidations.liquidate(defaulter_1, { from: owner });
      assert.isTrue(txL1.receipt.status)
      const expP_1 = await th.getNewPAfterLiquidation(contracts, txL1, P_0, liqDeposits, lastLUSDError)
      P_1 = await stabilityPool.P()
      assert.isTrue(P_1.eq(expP_1))
      assert.equal(await stabilityPool.currentScale(), '0')

      // B deposits 99999 LUSD
      await lusdToken.transfer(bob, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: bob })

      P_1 = await stabilityPool.P()
      // Defaulter 2 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL2 = await liquidations.liquidate(defaulter_2, { from: owner });
      assert.isTrue(txL2.receipt.status)
      const expP_2 = await th.getNewPAfterLiquidation(contracts, txL2, P_1, liqDeposits, lastLUSDError)
      P_2 = await stabilityPool.P()
      // scale change
      assert.equal(await stabilityPool.currentScale(), '1')
      assert.isTrue((P_2.div(toBN(dec(1,9)))).eq(expP_2))

      // C deposits 99999 LUSD
      await lusdToken.transfer(carol, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: carol })

      P_2 = await stabilityPool.P()
      // Defaulter 3 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL3 = await liquidations.liquidate(defaulter_3, { from: owner });
      assert.isTrue(txL3.receipt.status)
      const expP_3 = await th.getNewPAfterLiquidation(contracts, txL3, P_2, liqDeposits, lastLUSDError)
      P_3 = await stabilityPool.P()
      assert.isTrue(P_3.eq(expP_3))
      assert.equal(await stabilityPool.currentScale(), '1')

      // D deposits 99999 LUSD
      await lusdToken.transfer(dennis, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: dennis })

      P_3 = await stabilityPool.P()
      // Defaulter 4 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL4 = await liquidations.liquidate(defaulter_4, { from: owner });
      assert.isTrue(txL4.receipt.status)
      const expP_4 = await th.getNewPAfterLiquidation(contracts, txL4, P_3, liqDeposits, lastLUSDError)
      P_4 = await stabilityPool.P()
      assert.isTrue(P_4.div(toBN(dec(1,9))).eq(expP_4))

      assert.equal(await stabilityPool.currentScale(), '2')

      const alice_ETHGainAt2ndScaleChange = (await stabilityPool.getDepositorCollateralGain(alice)).toString()

      // E deposits 99999 LUSD
      await lusdToken.transfer(erin, dec(99999, 18), { from: whale })
      await stabilityPool.provideToSP(dec(99999, 18), ZERO_ADDRESS, { from: erin })
  
      P_4 = await stabilityPool.P()
      // Defaulter 5 liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      const txL5 = await liquidations.liquidate(defaulter_5, { from: owner });
      assert.isTrue(txL5.receipt.status)
      const expP_5 = await th.getNewPAfterLiquidation(contracts, txL5, P_4, liqDeposits, lastLUSDError)
      P_5 = await stabilityPool.P()
      assert.isTrue(P_5.eq(expP_5))

      assert.equal(await stabilityPool.currentScale(), '2')

      const alice_ETHGainAfterFurtherLiquidation = (await stabilityPool.getDepositorCollateralGain(alice)).toString()
  
      const alice_scaleSnapshot = (await stabilityPool.depositSnapshots(alice))[2].toString()

      assert.equal(alice_scaleSnapshot, '0')
      assert.equal(alice_ETHGainAt2ndScaleChange, alice_ETHGainAfterFurtherLiquidation)
    })

    // --- Extreme values, confirm no overflows ---

    it("withdrawFromSP(): Large liquidated coll/debt, deposits and ETH price", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      // ETH:USD price is $2 billion per ETH
      await priceFeed.setPrice(dec(2, 27));

      // Defaulter opens trove with 200% ICR
      await borrowerOperations.openTrove(dec(1, 27), await getOpenTroveLUSDAmount(dec(1, 36)), defaulter_1, defaulter_1, false, { from: defaulter_1 })

      // do all openTroves first
      const depositors = [alice, bob]
      spDeposit = toBN(dec(1, 36))
      for (account of depositors) {
        await borrowerOperations.openTrove(dec(2, 27), spDeposit, account, account, false, { from: account })
      }

      // first provide doesn't drip
      await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: alice })

      tx1 = await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: bob })
      const [,drip1] = await th.getEmittedDripValues(contracts, tx1) 

      aliceDrip = drip1
      aliceStartingDeposit = spDeposit.add(drip1)
      bobStartingDeposit = spDeposit

      totalStartingDeposits = aliceStartingDeposit.add(bobStartingDeposit)

      assert.isAtMost(th.getDifference(await stabilityPool.getCompoundedLUSDDeposit(alice), aliceStartingDeposit), 1e18)
      assert.isAtMost(th.getDifference(await stabilityPool.getCompoundedLUSDDeposit(bob), bobStartingDeposit), 1e18)

      // ETH:USD price drops to $1 billion per ETH
      await priceFeed.setPrice(dec(1, 27));

      P_0 = (await stabilityPool.P())
      assert.isTrue(P_0.gt(toBN(dec(1,18))))

      // Defaulter liquidated
      // need these two variables to calc new P
      // will use P to calculate expected deposits since th.depositsAfterLiquidation() is not
      // exact and has large error in this test case w/ huge deposits
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx2 = await liquidations.liquidate(defaulter_1, { from: owner });
      var [aliceDeposit, bobDeposit] = (await th.depositsAfterLiquidation(contracts, tx2, [aliceStartingDeposit, bobStartingDeposit]))
      const expP_1 = await th.getNewPAfterLiquidation(contracts, tx2, P_0, liqDeposits, lastLUSDError)

      // ensure expected P is correct
      currentP = (await stabilityPool.P())
      assert.isTrue(currentP.eq(expP_1))

      totalDeposits = await stabilityPool.getTotalLUSDDeposits()

      /*
      // use P to calc deposit
      expDepositWithP = expP_1.mul(spDeposit).div(toBN(dec(1, 18)))

      // Use internal snapshot logic to calc expected deposit
      initialValue = (await stabilityPool.deposits(alice))[0]
      const { S, P, G, scale } = (await stabilityPool.depositSnapshots(alice))
      expDeposit = initialValue.mul(currentP).div(P)

      // ensure both outputs are equal
      assert.isTrue(expDeposit.eq(expDepositWithP))
      */

      // whale deposits 1 LUSD so all can exit
      tx3 = await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      const [,drip3] = await th.getEmittedDripValues(contracts, tx3)

      aliceDrip = drip3.mul(aliceDeposit).div(totalDeposits)
      aliceDeposit = aliceDeposit.add(aliceDrip)

      bobDrip = drip3.mul(bobDeposit).div(totalDeposits)
      bobDeposit = bobDeposit.add(bobDrip)

      totalDeposits = totalDeposits.add(drip3).add(toBN(dec(1,18)))

      const txA = await stabilityPool.withdrawFromSP(dec(1, 36), { from: alice })
      const [,dripA] = await th.getEmittedDripValues(contracts, txA)
      aliceDrip = dripA.mul(aliceDeposit).div(totalDeposits)
      aliceDeposit = aliceDeposit.add(aliceDrip)

      bobDrip = dripA.mul(bobDeposit).div(totalDeposits)
      bobDeposit = bobDeposit.add(bobDrip)

      totalDeposits = totalDeposits.add(dripA).sub(aliceDeposit)


      const txB = await stabilityPool.withdrawFromSP(dec(1, 36), { from: bob })
      const [,dripB] = await th.getEmittedDripValues(contracts, txB)

      bobDrip = dripB.mul(bobDeposit).div(totalDeposits)
      bobDeposit = bobDeposit.add(bobDrip)

      totalDeposits = totalDeposits.add(dripB).sub(bobDeposit)

      // Grab the ETH gain from the emitted event in the tx log
      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral')
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral')

      // Check LUSD balances
      const aliceLUSDBalance = await lusdToken.balanceOf(alice)
      const aliceLUSDBalDiff = aliceLUSDBalance.sub(aliceDeposit).abs()
      // had to increase tolerance because of inaccuracy in th.depositsAfterLiquidation()
      assert.isTrue(aliceLUSDBalDiff.lte(toBN(dec(3, 18)))) // error tolerance of 1e18

      const bobLUSDBalance = await lusdToken.balanceOf(bob)
      const bobLUSDBalDiff = bobLUSDBalance.sub(bobDeposit).abs()

      // had to increase tolerance because of inaccuracy in th.depositsAfterLiquidation()
      assert.isTrue(bobLUSDBalDiff.lte(toBN(dec(21, 17))))

      // Check ETH gains
      aliceExpectedETHGain = toBN(dec(9950, 23)).mul(aliceStartingDeposit).div(totalStartingDeposits)
      bobExpectedETHGain = toBN(dec(9950, 23)).mul(bobStartingDeposit).div(totalStartingDeposits)

      const aliceETHDiff = aliceExpectedETHGain.sub(toBN(alice_CollateralWithdrawn))
      assert.isTrue(aliceETHDiff.lte(toBN(dec(1, 18))))

      const bobETHDiff = bobExpectedETHGain.sub(toBN(bob_CollateralWithdrawn))
      assert.isTrue(bobETHDiff.lte(toBN(dec(1, 18))))
    })

    it("withdrawFromSP(): Small liquidated coll/debt, large deposits and ETH price", async () => {
      // Whale opens Trove with 100k ETH
      await borrowerOperations.openTrove(dec(100000, 'ether'), await getOpenTroveLUSDAmount(dec(100000, 18)), whale, whale, false, { from: whale })

      // ETH:USD price is $2 billion per ETH
      await priceFeed.setPrice(dec(2, 27));
      const price = await priceFeed.getPrice()

      // Defaulter opens trove with 50e-7 ETH and  5000 LUSD. 200% ICR
      await borrowerOperations.openTrove(toBN('5000000000000'), await getOpenTroveLUSDAmount(dec(5000, 18)), defaulter_1, defaulter_1, false, { from: defaulter_1 })

      const depositors = [alice, bob]
      spDeposit = toBN(dec(1, 38))
      for (account of depositors) {
        await collateralToken.mint(account, dec(2, 29), { from: owner })
        await collateralToken.approve(activePool.address, dec(2, 29), { from: account })
        await borrowerOperations.openTrove(dec(2, 29), spDeposit, account, account, false, { from: account })
      }

      for (account of depositors) {
        await stabilityPool.provideToSP(spDeposit, ZERO_ADDRESS, { from: account })
      }

      // ETH:USD price drops to $1 billion per ETH
      await priceFeed.setPrice(dec(1, 27));

      P_0 = await stabilityPool.P()
      assert.isTrue(P_0.gt(toBN(dec(1,18))))

      // Defaulter liquidated
      liqDeposits = await stabilityPool.getTotalLUSDDeposits()
      lastLUSDError = await stabilityPool.lastLUSDLossError_Offset()
      tx = await liquidations.liquidate(defaulter_1, { from: owner });
      //const finalDeposit = (await th.depositsAfterLiquidation(contracts, tx, [spDeposit, spDeposit]))[0]
      const expP_1 = await th.getNewPAfterLiquidation(contracts, tx, P_0, liqDeposits, lastLUSDError)

      aliceDeposit = await stabilityPool.getCompoundedLUSDDeposit(alice)
      bobDeposit = await stabilityPool.getCompoundedLUSDDeposit(bob)
      totalDeposits = await stabilityPool.getTotalLUSDDeposits()


      // ensure expected P is correct
      currentP = (await stabilityPool.P())
      //assert.isTrue(currentP.eq(expP_1))

      /*
      // use P to calc deposit
      expDepositWithP = expP_1.mul(spDeposit).div(toBN(dec(1, 18)))

      // Use internal snapshot logic to calc expected deposit
      initialValue = (await stabilityPool.deposits(alice))[0]
      const { S, P, G, scale } = (await stabilityPool.depositSnapshots(alice))
      expDeposit = initialValue.mul(currentP).div(P)

      // ensure both outputs are equal
      assert.isTrue(expDeposit.eq(expDepositWithP))
      */

      // whale deposits 1 LUSD so all can exit
      tx3 = await stabilityPool.provideToSP(dec(1, 18), ZERO_ADDRESS, { from: whale })
      const [,drip3] = await th.getEmittedDripValues(contracts, tx3)

      aliceDrip = drip3.mul(aliceDeposit).div(totalDeposits)
      aliceDeposit = aliceDeposit.add(aliceDrip)

      bobDrip = drip3.mul(bobDeposit).div(totalDeposits)
      bobDeposit = bobDeposit.add(bobDrip)

      totalDeposits = totalDeposits.add(drip3).add(toBN(dec(1,18)))

      const txA = await stabilityPool.withdrawAllFromSP({ from: alice })
      const [,dripA] = await th.getEmittedDripValues(contracts, txA)
      aliceDrip = dripA.mul(aliceDeposit).div(totalDeposits)
      aliceDeposit = aliceDeposit.add(aliceDrip)

      bobDrip = dripA.mul(bobDeposit).div(totalDeposits)
      bobDeposit = bobDeposit.add(bobDrip)

      totalDeposits = totalDeposits.add(dripA).sub(aliceDeposit)

      const txB = await stabilityPool.withdrawAllFromSP({ from: bob })
      const [,dripB] = await th.getEmittedDripValues(contracts, txB)

      bobDrip = dripB.mul(bobDeposit).div(totalDeposits)
      bobDeposit = bobDeposit.add(bobDrip)

      totalDeposits = totalDeposits.add(dripB).sub(bobDeposit)

      const alice_CollateralWithdrawn = th.getEventArgByName(txA, 'CollateralGainWithdrawn', '_collateral')
      const bob_CollateralWithdrawn = th.getEventArgByName(txB, 'CollateralGainWithdrawn', '_collateral')

      const aliceLUSDBalance = await lusdToken.balanceOf(alice)
      const aliceLUSDBalDiff = aliceLUSDBalance.sub(aliceDeposit).abs()
      console.log("aliceLUSDBalDiff "  + aliceLUSDBalDiff)

      assert.isTrue(aliceLUSDBalDiff.lte(toBN(dec(100, 18))))

      const bobLUSDBalance = await lusdToken.balanceOf(bob)
      const bobLUSDBalDiff = bobLUSDBalance.sub(bobDeposit).abs()

      assert.isTrue(aliceLUSDBalDiff.lte(toBN(dec(100, 18))))

      // Expect ETH gain per depositor of ~1e11 wei to be rounded to 0 by the ETHGainedPerUnitStaked calculation (e / D), where D is ~1e36.
      assert.equal(alice_CollateralWithdrawn.toString(), '0')
      assert.equal(bob_CollateralWithdrawn.toString(), '0')
    })
  })
})

contract('Reset chain state', async accounts => { })
