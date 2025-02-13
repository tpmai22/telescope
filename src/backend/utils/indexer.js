require('../lib/config');

const { setIntervalAsync, clearIntervalAsync } = require('set-interval-async/dynamic');

const { ELASTIC_MAX_RESULTS_PER_PAGE = 5, POSTS_URL = 'http://localhost/v1/posts' } = process.env;
const { client } = require('../lib/elastic');
const { logger } = require('./logger');

const index = 'posts';

/*
  Creates 'posts' index and add settings and mapping for autocomplete if the index doesn't already exist
  exists API: https://www.elastic.co/guide/en/elasticsearch/reference/master/indices-exists.html
  create API: https://www.elastic.co/guide/en/elasticsearch/reference/master/indices-create-index.html

  Analysis settings are used to define our custom analyzers and tokenizers
  analyzer: https://www.elastic.co/guide/en/elasticsearch/reference/current/analyzer.html
  search_analyzer: https://www.elastic.co/guide/en/elasticsearch/reference/current/search-analyzer.html

  Token filters are built in filters to build customized analyzers
  'lowercase' changes text to lowercase: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-lowercase-tokenfilter.html
  'remove_duplicates' removes duplicate tokens in the same position: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-remove-duplicates-tokenfilter.html
  creating a custom analyzer: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-custom-analyzer.html

  Edge n-gram tokenizer is used for our custom autocomplete tokenizer
  tokenizer reference: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-tokenizers.html
  Edge n-gram tokenizer: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-edgengram-tokenizer.html

  'min_gram' and 'max_gram' are the minimum and maximum length of characters in a gram.
  There are some max_gram limitations: https://www.elastic.co/guide/en/elasticsearch/reference/current/analysis-edgengram-tokenizer.html#max-gram-limits

  'token_chars' are character classes that are included in a token.
  Currently set at 'letter' and 'digit'

  Mapping is used to set the custom author.autocomplete field to use our custom analyzers
  mapping: https://www.elastic.co/guide/en/elasticsearch/reference/current/mapping.html
  fields: https://www.elastic.co/guide/en/elasticsearch/reference/current/multi-fields.html
*/
const setupPostsIndex = async () => {
  try {
    const response = await client.indices.exists({ index });
    // If the index doesn't exist, 404 statusCode is returned
    if (response.statusCode === 404) {
      await client.indices.create({
        index,
        body: {
          settings: {
            analysis: {
              analyzer: {
                autocomplete_analyzer: {
                  tokenizer: 'autocomplete',
                  filter: ['lowercase', 'remove_duplicates'],
                },
                autocomplete_search_analyzer: {
                  tokenizer: 'lowercase',
                },
              },
              tokenizer: {
                autocomplete: {
                  type: 'edge_ngram',
                  min_gram: 1,
                  max_gram: 20,
                  token_chars: ['letter', 'digit'],
                },
              },
            },
          },
          mappings: {
            properties: {
              author: {
                type: 'text',
                fields: {
                  autocomplete: {
                    type: 'text',
                    analyzer: 'autocomplete_analyzer',
                    search_analyzer: 'autocomplete_search_analyzer',
                  },
                },
                analyzer: 'standard',
              },
            },
          },
        },
      });
    }
  } catch (error) {
    logger.error({ error }, `Error setting up ${index} index`);
  }
};

/**
 * Indexes the text and id from a post
 * @param post
 * @param post.text from a post
 * @param post.id same id used to store on redis the post object where the text is from
 * @param post.title from a post
 * @param post.published from a post
 * @param post.author from a post
 */
const indexPost = async ({ text, id, title, published, author }) => {
  try {
    await client.index({
      index,
      id,
      body: {
        text,
        title,
        published,
        author,
      },
    });
  } catch (error) {
    logger.error({ error }, `There was an error indexing a post for id ${id}`);
  }
};

/**
 * Deletes a previously indexed post by its id
 * @param postId same id used to store on redis the post object where the text is from
 */
const deletePost = async (postId) => {
  try {
    await client.delete({
      index,
      id: postId,
    });
  } catch (error) {
    logger.error({ error }, `There was an error deleting the post with id ${postId}`);
  }
};

/**
 * Creates fields from filter, now the filter is used for author and post but it will be added more.
 * the fields will be used for ES
 * @param {string} filter
 */
const createFieldsFromFilter = (filter) => {
  switch (filter) {
    case 'author':
      return ['author'];
    case 'post':
    default:
      return ['text', 'title'];
  }
};

const sortFromFilter = (filter) => {
  switch (filter) {
    case 'author':
      return [{ published: { order: 'desc' } }];
    case 'post':
    default:
      return undefined;
  }
};

const calculateFrom = (page, perPage) => {
  const ES_MAX = 10000; // 10K is the upper limit of what ES will return without issue for searches
  const wanted = page * perPage;
  // Don't exceed 10K, and if we will, return an offset under it by one page size
  return wanted + perPage <= ES_MAX ? wanted : ES_MAX - perPage;
};

/**
 * Searches text in elasticsearch
 * @param textToSearch
 * @param filter
 * @return all the results matching the passed text
 */
const search = async (
  textToSearch,
  filter = 'post',
  page = 0,
  perPage = ELASTIC_MAX_RESULTS_PER_PAGE
) => {
  const query = {
    query: {
      simple_query_string: {
        query: textToSearch,
        default_operator: 'and',
        fields: createFieldsFromFilter(filter),
      },
    },
    sort: sortFromFilter(filter),
  };

  const {
    body: { hits },
  } = await client.search({
    from: calculateFrom(page, perPage),
    size: perPage,
    _source: ['id'],
    index,
    body: query,
  });

  return {
    results: hits.total.value,
    values: hits.hits.map(({ _id }) => ({ id: _id, url: `${POSTS_URL}/${_id}` })),
  };
};

/**
 * Checks elasticsearch's connectivity
 */
const checkConnection = () => client.cluster.health();

const waitOnReady = async () => {
  /**
   * Elasticsearch needs time after deployment for setting up all its components.
   * Here we set a timer using 'setTimeout' and check for connectivity during the countdown so elasticsearch
   * has time to be fully prepared to start indexing posts.
   */
  const DELAY = process.env.ELASTIC_DELAY_MS || 10000;
  let intervalId;
  let timerId;

  const timer = new Promise((resolve, reject) => {
    timerId = setTimeout(() => {
      reject(
        new Error(
          'Unable to connect to Elasticsearch. Use `MOCK_ELASTIC=1` in your `.env` to mock Elasticsearch, or install (see https://github.com/Seneca-CDOT/telescope/blob/master/docs/environment-setup.md)'
        )
      );
    }, DELAY);
  });

  const connectivity = new Promise((resolve) => {
    intervalId = setIntervalAsync(async () => {
      try {
        await checkConnection();
        resolve();
      } catch (error) {
        logger.info('Attempting to connect to elasticsearch...');
      }
    }, 500);
  });

  await Promise.race([timer, connectivity]);

  await clearIntervalAsync(intervalId);
  clearTimeout(timerId);

  // Once elasticsearch is connected, set up `posts` index for autocomplete
  await setupPostsIndex();
};

module.exports = {
  indexPost,
  deletePost,
  checkConnection,
  search,
  waitOnReady,
};
