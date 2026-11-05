import { sequelize, User, Document, QAPair, initDatabase } from './db.mjs';

async function testDatabase() {
  try {
    console.log('Testing SQLite + Sequelize connection and models...');
    await sequelize.authenticate();
    console.log('✓ SQLite connection successful.');

    await initDatabase({ force: true });
    console.log('✓ Tables synced and initial data seeded.');

    // Query Users
    const users = await User.findAll();
    console.log(`✓ Users query: Found ${users.length} users (${users.map(u => `${u.username} [${u.role}]`).join(', ')})`);

    // Query Documents with QAPairs
    const docs = await Document.findAll({
      include: [{ model: QAPair, as: 'qaPairs' }]
    });
    console.log(`✓ Documents query: Found ${docs.length} document(s).`);
    for (const doc of docs) {
      console.log(`   - Doc ID ${doc.id}: ${doc.filename} (Status: ${doc.status}) with ${doc.qaPairs.length} Q&A pair(s).`);
      for (const qa of doc.qaPairs) {
        console.log(`     * QA ID ${qa.id}: Status=${qa.status}, Prompt preview="${qa.prompt.substring(0, 40)}..."`);
      }
    }

    console.log('\nAll database tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Database test failed:', error);
    process.exit(1);
  }
}

testDatabase();
