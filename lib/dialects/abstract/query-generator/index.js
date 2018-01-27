'use strict';

const util = require('util');
const _ = require('lodash');

const Utils = require('../../../utils');
const SqlString = require('../../../sql-string');
const DataTypes = require('../../../data-types');
const Model = require('../../../model');
const Association = require('../../../associations/base');

const QuoteHelper = require('./helpers/quote');

/**
 * Abstract Query Generator
 *
 * @private
 */
class QueryGenerator {
  constructor(options) {
    if (!options.sequelize) throw new Error('QueryGenerator initialized without options.sequelize');
    if (!options._dialect) throw new Error('QueryGenerator initialized without options._dialect');

    this.sequelize = options.sequelize;
    this.options = options.sequelize.options;

    // dialect name
    this.dialect = options._dialect.name;
    this._dialect = options._dialect;

    // template config
    this._templateSettings = require('lodash').runInContext().templateSettings;
  }

  extractTableDetails(tableName, options) {
    options = options || {};
    tableName = tableName || {};
    return {
      schema: tableName.schema || options.schema || 'public',
      tableName: _.isPlainObject(tableName) ? tableName.tableName : tableName,
      delimiter: tableName.delimiter || options.delimiter || '.'
    };
  }

  addSchema(param) {
    const self = this;
    if (!param._schema) return param.tableName || param;

    return {
      tableName: param.tableName || param,
      table: param.tableName || param,
      name: param.name || param,
      schema: param._schema,
      delimiter: param._schemaDelimiter || '.',
      toString() {
        return self.quoteTable(this);
      }
    };
  }

  nameIndexes(indexes, rawTablename) {
    if (typeof rawTablename === 'object') {
      // don't include schema in the index name
      rawTablename = rawTablename.tableName;
    }

    return _.map(indexes, index => {
      if (!index.hasOwnProperty('name')) {
        const onlyAttributeNames = index.fields.map(field => typeof field === 'string' ? field : field.name || field.attribute);
        index.name = Utils.underscore(rawTablename + '_' + onlyAttributeNames.join('_'));
      }

      return index;
    });
  }

  /*
    Quote an object based on its type. This is a more general version of quoteIdentifiers
    Strings: should proxy to quoteIdentifiers
    Arrays:
      * Expects array in the form: [<model> (optional), <model> (optional),... String, String (optional)]
        Each <model> can be a model, or an object {model: Model, as: String}, matching include, or an
        association object, or the name of an association.
      * Zero or more models can be included in the array and are used to trace a path through the tree of
        included nested associations. This produces the correct table name for the ORDER BY/GROUP BY SQL
        and quotes it.
      * If a single string is appended to end of array, it is quoted.
        If two strings appended, the 1st string is quoted, the 2nd string unquoted.
    Objects:
      * If raw is set, that value should be returned verbatim, without quoting
      * If fn is set, the string should start with the value of fn, starting paren, followed by
        the values of cols (which is assumed to be an array), quoted and joined with ', ',
        unless they are themselves objects
      * If direction is set, should be prepended

    Currently this function is only used for ordering / grouping columns and Sequelize.col(), but it could
    potentially also be used for other places where we want to be able to call SQL functions (e.g. as default values)
   @private
  */
  quote(collection, parent, connector) {
    // init
    const validOrderOptions = [
      'ASC',
      'DESC',
      'ASC NULLS LAST',
      'DESC NULLS LAST',
      'ASC NULLS FIRST',
      'DESC NULLS FIRST',
      'NULLS FIRST',
      'NULLS LAST'
    ];

    // default
    connector = connector || '.';

    // just quote as identifiers if string
    if (typeof collection === 'string') {
      return this.quoteIdentifiers(collection);
    } else if (Array.isArray(collection)) {
      // iterate through the collection and mutate objects into associations
      collection.forEach((item, index) => {
        const previous = collection[index - 1];
        let previousAssociation;
        let previousModel;

        // set the previous as the parent when previous is undefined or the target of the association
        if (!previous && parent !== undefined) {
          previousModel = parent;
        } else if (previous && previous instanceof Association) {
          previousAssociation = previous;
          previousModel = previous.target;
        }

        // if the previous item is a model, then attempt getting an association
        if (previousModel && previousModel.prototype instanceof Model) {
          let model;
          let as;

          if (typeof item === 'function' && item.prototype instanceof Model) {
            // set
            model = item;
          } else if (_.isPlainObject(item) && item.model && item.model.prototype instanceof Model) {
            // set
            model = item.model;
            as = item.as;
          }

          if (model) {
            // set the as to either the through name or the model name
            if (!as && previousAssociation && previousAssociation instanceof Association && previousAssociation.through && previousAssociation.through.model === model) {
              // get from previous association
              item = new Association(previousModel, model, {
                as: model.name
              });
            } else {
              // get association from previous model
              item = previousModel.getAssociationForAlias(model, as);

              // attempt to use the model name if the item is still null
              if (!item) {
                item = previousModel.getAssociationForAlias(model, model.name);
              }
            }

            // make sure we have an association
            if (!(item instanceof Association)) {
              throw new Error(util.format('Unable to find a valid association for model, \'%s\'', model.name));
            }
          }
        }

        if (typeof item === 'string') {
          // get order index
          const orderIndex = validOrderOptions.indexOf(item.toUpperCase());

          // see if this is an order
          if (index > 0 && orderIndex !== -1) {
            item = this.sequelize.literal(' ' + validOrderOptions[orderIndex]);
          } else if (previousModel && previousModel.prototype instanceof Model) {
            // only go down this path if we have preivous model and check only once
            if (previousModel.associations !== undefined && previousModel.associations[item]) {
              // convert the item to an association
              item = previousModel.associations[item];
            } else if (previousModel.rawAttributes !== undefined && previousModel.rawAttributes[item] && item !== previousModel.rawAttributes[item].field) {
              // convert the item attribute from its alias
              item = previousModel.rawAttributes[item].field;
            } else if (
              item.indexOf('.') !== -1
              && previousModel.rawAttributes !== undefined
            ) {
              const itemSplit = item.split('.');

              if (previousModel.rawAttributes[itemSplit[0]].type instanceof DataTypes.JSON) {
                // just quote identifiers for now
                const identifier = this.quoteIdentifiers(previousModel.name  + '.' + previousModel.rawAttributes[itemSplit[0]].field);

                // get path
                const path = itemSplit.slice(1);

                // extract path
                item = this.jsonPathExtractionQuery(identifier, path);

                // literal because we don't want to append the model name when string
                item = this.sequelize.literal(item);
              }
            }
          }
        }

        collection[index] = item;
      }, this);

      // loop through array, adding table names of models to quoted
      const collectionLength = collection.length;
      const tableNames = [];
      let item;
      let i = 0;

      for (i = 0; i < collectionLength - 1; i++) {
        item = collection[i];
        if (typeof item === 'string' || item._modelAttribute || item instanceof Utils.SequelizeMethod) {
          break;
        } else if (item instanceof Association) {
          tableNames[i] = item.as;
        }
      }

      // start building sql
      let sql = '';

      if (i > 0) {
        sql += this.quoteIdentifier(tableNames.join(connector)) + '.';
      } else if (typeof collection[0] === 'string' && parent) {
        sql += this.quoteIdentifier(parent.name) + '.';
      }

      // loop through everything past i and append to the sql
      collection.slice(i).forEach(collectionItem => {
        sql += this.quote(collectionItem, parent, connector);
      }, this);

      return sql;
    } else if (collection._modelAttribute) {
      return this.quoteTable(collection.Model.name) + '.' + this.quoteIdentifier(collection.fieldName);
    } else if (collection instanceof Utils.SequelizeMethod) {
      return this.handleSequelizeMethod(collection);
    } else if (_.isPlainObject(collection) && collection.raw) {
      // simple objects with raw is no longer supported
      throw new Error('The `{raw: "..."}` syntax is no longer supported.  Use `sequelize.literal` instead.');
    } else {
      throw new Error('Unknown structure passed to order / group: ' + util.inspect(collection));
    }
  }

  quoteIdentifier(identifier, force) {
    return QuoteHelper.quoteIdentifier(this.dialect, identifier, {
      force,
      quoteIdentifiers: this.options.quoteIdentifiers
    });
  }

  /**
   * Split a list of identifiers by "." and quote each part
   *
   * @param {String}  dialect         Dialect name
   * @param {String} identifiers
   * @param {Object}  [options]
   * @param {Boolean} [options.force=false]
   * @param {Boolean} [options.quoteIdentifiers=true]
   *
   * @returns {String}
   */
  quoteIdentifiers(identifiers) {
    if (identifiers.indexOf('.') !== -1) {
      identifiers = identifiers.split('.');

      const head = identifiers.slice(0, identifiers.length - 1).join('.');
      const tail = identifiers[identifiers.length - 1];

      return this.quoteIdentifier(head) + '.' + this.quoteIdentifier(tail);
    }

    return this.quoteIdentifier(identifiers);
  }

  /**
   * Quote table name with optional alias and schema attribution
   *
   * @param {String|Object}  param table string or object
   * @param {String|Boolean} alias alias name
   *
   * @returns {String}
   */
  quoteTable(param, alias) {
    let table = '';

    if (alias === true) {
      alias = param.as || param.name || param;
    }

    if (_.isObject(param)) {
      if (this._dialect.supports.schemas) {
        if (param.schema) {
          table += this.quoteIdentifier(param.schema) + '.';
        }

        table += this.quoteIdentifier(param.tableName);
      } else {
        if (param.schema) {
          table += param.schema + (param.delimiter || '.');
        }

        table += param.tableName;
        table = this.quoteIdentifier(table);
      }
    } else {
      table = this.quoteIdentifier(param);
    }

    if (alias) {
      table += ' AS ' + this.quoteIdentifier(alias);
    }

    return table;
  }

  /*
    Escape a value (e.g. a string, number or date)
    @private
  */
  escape(value, field, options) {
    options = options || {};

    if (value !== null && value !== undefined) {
      if (value instanceof Utils.SequelizeMethod) {
        return this.handleSequelizeMethod(value);
      } else {
        if (field && field.type) {
          if (this.typeValidation && field.type.validate && value) {
            if (options.isList && Array.isArray(value)) {
              for (const item of value) {
                field.type.validate(item, options);
              }
            } else {
              field.type.validate(value, options);
            }
          }

          if (field.type.stringify) {
            // Users shouldn't have to worry about these args - just give them a function that takes a single arg
            const simpleEscape = _.partialRight(SqlString.escape, this.options.timezone, this.dialect);

            value = field.type.stringify(value, { escape: simpleEscape, field, timezone: this.options.timezone, operation: options.operation });

            if (field.type.escape === false) {
              // The data-type already did the required escaping
              return value;
            }
          }
        }
      }
    }

    return SqlString.escape(value, this.options.timezone, this.dialect);
  }

  isIdentifierQuoted(identifier) {
    return QuoteHelper.isIdentifierQuoted(identifier);
  }

  /**
   * Generates an SQL query that extract JSON property of given path.
   *
   * @param   {String}               column  The JSON column
   * @param   {String|Array<String>} [path]  The path to extract (optional)
   * @returns {String}                       The generated sql query
   * @private
   */
  jsonPathExtractionQuery(column, path) {
    let paths = _.toPath(path);
    let pathStr;
    let quotedColumn;

    switch(this.dialect) {
      case 'mysql':
        /**
         * Sub paths need to be quoted as ECMAScript identifiers
         * https://bugs.mysql.com/bug.php?id=81896
         */
        paths = paths.map(subPath => Utils.addTicks(subPath, '"'));
        pathStr = `${['$'].concat(paths).join('.')}`;
        quotedColumn = this.isIdentifierQuoted(column)
          ? column
          : this.quoteIdentifier(column);

        return `(${quotedColumn}->>'${pathStr}')`;

      case 'sqlite':
        pathStr = this.escape(['$']
          .concat(paths)
          .join('.')
          .replace(/\.(\d+)(?:(?=\.)|$)/g, (_, digit) => `[${digit}]`));
        quotedColumn = this.isIdentifierQuoted(column)
          ? column
          : this.quoteIdentifier(column);

        return `json_extract(${quotedColumn}, ${pathStr})`;

      case 'postgres':
        pathStr = this.escape(`{${paths.join(',')}}`);
        quotedColumn = this.isIdentifierQuoted(column)
          ? column
          : this.quoteIdentifier(column);

        return `(${quotedColumn}#>>${pathStr})`;

      default:
        throw new Error(`Unsupported ${this.dialect} for JSON operations`);
    }

  }
}

_.assignIn(QueryGenerator.prototype, require('./transaction'));
_.assignIn(QueryGenerator.prototype, require('./others'));

module.exports = QueryGenerator;
